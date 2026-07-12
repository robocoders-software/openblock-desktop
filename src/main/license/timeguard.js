// ─────────────────────────────────────────────────────────────────────────────
// Anti-rollback time guard — persists "last seen time" in SEVERAL places and
// always trusts the LATEST one. This prevents turning the clock back to dodge
// license expiry.
//
// Design rules
// ────────────
//   • WRITE: stamp the current time into every location (best-effort).
//   • READ : collect all locations and take the MAXIMUM (newest) timestamp.
//
//       → Deleting some locations does NOT reset the guard — the newest
//         survivor still wins. An attacker must wipe ALL of them at once.
//
//   • Each stored value is HMAC-tagged (secret + machineId). A hand-edited or
//     lowered value fails its tag and is ignored (treated as missing). So you
//     cannot simply edit a file down to fake an earlier time.
//
//   • Binding the tag to machineId means a stamp copied from another PC is
//     rejected too.
//
// Locations (Windows): %ProgramData%, %APPDATA%, %LOCALAPPDATA%, and the
// registry (HKCU). At least the AppData + registry ones are always writable by
// a normal user; ProgramData adds a machine-wide copy when permitted.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execFileSync } = require('child_process');

const NS = 'RoboCodersStudio';   // product namespace for anti-rollback stamp locations
const FILE = '.lrt';             // "last run time" marker file
const REG_KEY = `HKCU\\Software\\${NS}`;
const REG_VAL = 'LastRun';

// ── candidate file paths (skip any env var that isn't set) ───────────────────
function fileLocations() {
  const locations = [];
  if (process.platform === 'win32') {
    locations.push(
      ...[process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA]
        .filter(Boolean)
        .map((dir) => path.join(dir, NS, FILE))
    );
  } else if (process.platform === 'darwin') {
    const home = process.env.HOME;
    if (home) {
      locations.push(path.join(home, 'Library', 'Application Support', NS, FILE));
      locations.push(path.join(home, 'Library', 'Caches', NS, FILE));
    }
  } else if (process.platform === 'linux') {
    const home = process.env.HOME;
    const xdgData = process.env.XDG_DATA_HOME
      || (home ? path.join(home, '.local', 'share') : null);
    if (xdgData) locations.push(path.join(xdgData, NS, FILE));
    if (home) locations.push(path.join(home, '.config', NS, FILE));
  }
  return locations;
}

// ── tamper-proof packing:  "<iso>|<hmac16>" ──────────────────────────────────
function tag(secret, machineId, iso) {
  return crypto.createHmac('sha256', secret).update(`${machineId}|${iso}`).digest('hex').slice(0, 16);
}
function pack(secret, machineId, iso) {
  return `${iso}|${tag(secret, machineId, iso)}`;
}
function unpackToMs(secret, machineId, raw) {
  if (!raw) return null;
  const i = raw.lastIndexOf('|');
  if (i === -1) return null;
  const iso = raw.slice(0, i).trim();
  const mac = raw.slice(i + 1).trim();
  if (tag(secret, machineId, iso) !== mac) return null;   // tampered → ignore
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// ── registry I/O (best-effort, Windows only) ─────────────────────────────────
function regRead() {
  try {
    const out = execFileSync('reg', ['query', REG_KEY, '/v', REG_VAL],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/REG_SZ\s+(.+?)\s*$/m);
    return m ? m[1].trim() : null;
  } catch { return null; }
}
function regWrite(value) {
  try {
    execFileSync('reg', ['add', REG_KEY, '/v', REG_VAL, '/t', 'REG_SZ', '/d', value, '/f'],
      { windowsHide: true, stdio: 'ignore' });
  } catch { /* ignore on non-Windows */ }
}

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Read the newest trusted "last run" timestamp across all locations.
 * @returns {number|null} milliseconds since epoch, or null if none found
 */
function readLastRun(secret, machineId) {
  const raws = [];
  for (const f of fileLocations()) {
    try { if (fs.existsSync(f)) raws.push(fs.readFileSync(f, 'utf8')); } catch { /* ignore */ }
  }
  raws.push(regRead());

  let maxMs = null;
  for (const raw of raws) {
    const ms = unpackToMs(secret, machineId, raw);
    if (ms !== null && (maxMs === null || ms > maxMs)) maxMs = ms;
  }
  return maxMs;
}

/** Stamp `date` into every location (best-effort). */
function writeLastRun(secret, machineId, date) {
  const value = pack(secret, machineId, date.toISOString());
  for (const f of fileLocations()) {
    try {
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, value);
    } catch { /* ignore unwritable location */ }
  }
  regWrite(value);
}

/**
 * OPTIONAL online time anchor (Layer C). Best-effort fetch of trusted UTC from a
 * public HTTPS server's `Date` response header. Races several well-known hosts and
 * resolves to the first answer (ms since epoch), or null if none reply in time.
 *
 * This is the ONLY reliable way to detect a forward clock change offline-undetectable
 * within MAX_FORWARD_GAP — but it is purely opportunistic: when it returns null the
 * caller falls back to the offline rules, so the app stays fully usable without internet.
 *
 * @param {number} timeoutMs per-request + overall budget
 * @returns {Promise<number|null>}
 */
function fetchTrustedTimeMs(timeoutMs = 2000) {
  const HOSTS = ['www.cloudflare.com', 'www.google.com', 'www.microsoft.com'];
  return new Promise((resolve) => {
    let settled = false;
    let pending = HOSTS.length;
    const finish = (ms) => {
      if (settled) return;
      if (ms !== null) { settled = true; resolve(ms); return; }
      if (--pending <= 0) { settled = true; resolve(null); }
    };
    const overall = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, timeoutMs + 250);
    if (overall.unref) overall.unref();

    for (const host of HOSTS) {
      let req;
      try {
        req = https.request({ host, method: 'HEAD', path: '/', timeout: timeoutMs }, (res) => {
          const d = res.headers && res.headers.date;
          res.destroy();
          const ms = d ? Date.parse(d) : NaN;
          finish(Number.isNaN(ms) ? null : ms);
        });
      } catch (_) { finish(null); continue; }
      req.on('error', () => finish(null));
      req.on('timeout', () => { try { req.destroy(); } catch (_) {} finish(null); });
      req.end();
    }
  });
}

/** How many locations currently hold a trusted value (for diagnostics). */
function locationsWithValue(secret, machineId) {
  let n = 0;
  for (const f of fileLocations()) {
    try { if (fs.existsSync(f) && unpackToMs(secret, machineId, fs.readFileSync(f, 'utf8')) !== null) n++; } catch {}
  }
  if (unpackToMs(secret, machineId, regRead()) !== null) n++;
  return n;
}

module.exports = { readLastRun, writeLastRun, locationsWithValue, fileLocations, fetchTrustedTimeMs, NS };
