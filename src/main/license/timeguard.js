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
const { execFileSync } = require('child_process');

const NS = 'OfflineLicense';     // change this per product
const FILE = '.lrt';             // "last run time" marker file
const REG_KEY = `HKCU\\Software\\${NS}`;
const REG_VAL = 'LastRun';

// ── candidate file paths (skip any env var that isn't set) ───────────────────
function fileLocations() {
  return [process.env.ProgramData, process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean)
    .map((dir) => path.join(dir, NS, FILE));
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

/** How many locations currently hold a trusted value (for diagnostics). */
function locationsWithValue(secret, machineId) {
  let n = 0;
  for (const f of fileLocations()) {
    try { if (fs.existsSync(f) && unpackToMs(secret, machineId, fs.readFileSync(f, 'utf8')) !== null) n++; } catch {}
  }
  if (unpackToMs(secret, machineId, regRead()) !== null) n++;
  return n;
}

module.exports = { readLastRun, writeLastRun, locationsWithValue, fileLocations, NS };
