// ─────────────────────────────────────────────────────────────────────────────
// License manager — the single place the desktop app talks to for licensing.
//
// Ties together:
//   • activation.js  — verify/decrypt the 21-char activation number
//   • storage.js     — encrypted license.dat (machine-bound)
//   • timeguard.js   — multi-location anti-clock-rollback "diary"
//   • machine.js     — this PC's Machine ID / hash
//   • keys.js        — SHARED_SECRET + LICENSE_NUMBER baked into this build
//
// Behaviour:
//   activate(key)   → verify (tamper + license# + machine + expiry), then store.
//   checkStartup()  → if a valid, unexpired license is stored, return ok WITHOUT
//                     asking for a key again. Also runs the clock-rollback guard.
//
// license.dat lives in Electron's userData dir and the timeguard writes to
// ProgramData/AppData/registry — all OUTSIDE the install folder, so uninstall +
// reinstall keeps the activation and the rollback memory intact.
// ─────────────────────────────────────────────────────────────────────────────

const { SHARED_SECRET, LICENSE_NUMBER } = require('./keys');
const { getMachineIdentity } = require('./machine');
const { verifyActivationNumber } = require('./activation');
const { saveEncrypted, loadEncrypted, remove } = require('./storage');
const { readLastRun, writeLastRun, fetchTrustedTimeMs } = require('./timeguard');

// How many days the system date may legitimately jump FORWARD past the furthest day
// the app has already reached (the high-water mark / HWM) before we treat it as
// tampering. This must comfortably exceed the longest realistic gap between uses, so a
// real user returning after a break is never falsely blocked. Single knob — tune freely.
// Trade-off of a LARGER value: fewer false blocks for users who leave the app closed for
// a long time, BUT a wider window in which a forward clock change goes UNdetected (up to
// this many days), and a larger accidental HWM jump if the app is opened while the clock
// is set ahead (then returning to the real earlier date is blocked as rollback until the
// real date catches back up). 90 days ≈ tolerate a full school-term/holiday gap.
const MAX_FORWARD_GAP_DAYS = 90;

// Online anchor tolerance: only a system-vs-trusted difference larger than this counts
// as a real clock change (absorbs network latency / sub-day jitter / timezone quirks).
const ONLINE_TOLERANCE_MS = 24 * 60 * 60 * 1000; // 24h

// A Date → LOCAL calendar date "YYYY-MM-DD". We use LOCAL time (not toISOString(),
// which is UTC) so comparisons match the calendar dates baked into the license and
// the user's wall clock — otherwise a timezone ahead of UTC can block/expire a day off.
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Today's LOCAL calendar date as YYYY-MM-DD.
function today() {
  return localDateStr(new Date());
}

// "YYYY-MM-DD" + n calendar days → "YYYY-MM-DD" (local).
function addDaysStr(dateStr, n) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return localDateStr(dt);
}

// PURE clock-guard decision (no I/O — unit-testable). Compares today's date against the
// high-water mark and the forward gap. Returns null when the date is acceptable, or a
// { reason, lastValidDate } object describing the block. Recovery is implicit: because the
// caller never advances the HWM while this returns a block, restoring the real date lands
// back inside [hwmDate … hwmDate+gapDays] and this returns null again.
//   A1 backward: today < hwmDate
//   A2 forward : today > hwmDate + gapDays
function evaluateClockGuard(todayStr, hwmDate, gapDays) {
  if (!hwmDate) return null;                 // first run — nothing to compare against
  if (todayStr < hwmDate) {
    return {
      reason: 'Clock manipulation detected — the system date was moved backward',
      lastValidDate: hwmDate,
    };
  }
  if (todayStr > addDaysStr(hwmDate, gapDays)) {
    return {
      reason: 'Clock manipulation detected — the system date was set too far ahead',
      lastValidDate: hwmDate,
    };
  }
  return null;
}

function createLicenseManager(licenseFilePath) {
  // Verify a raw key against this build + this machine + the calendar.
  function verify(rawKey, machineId) {
    const r = verifyActivationNumber(rawKey, {
      secret: SHARED_SECRET,
      expectedLicenseNumber: LICENSE_NUMBER,
      machineId,
    });
    if (!r.valid) return r;

    // activation.js returns the dates but does not compare them to "today"
    if (today() < r.startDate) {
      return { valid: false, reason: 'This license is not valid until ' + r.startDate };
    }
    if (today() > r.expiryDate) {
      return { valid: false, reason: 'This license expired on ' + r.expiryDate };
    }
    return r;
  }

  function license(r) {
    return {
      machineId: r.machineId,
      startDate: r.startDate,
      expiryDate: r.expiryDate,
      licenseNumber: r.licenseNumber,
    };
  }

  return {
    /** Full 16-hex Machine ID shown on the activation screen. */
    getMachineId() {
      return getMachineIdentity().machineId;
    },

    /** Algorithm 3 — activate and persist. Called from the activation screen. */
    activate(rawKey) {
      const id = getMachineIdentity();
      const key = String(rawKey).trim();
      const r = verify(key, id.machineId);
      if (!r.valid) return { valid: false, reason: r.reason };

      // store the key (encrypted, bound to the full machine hash) and seed the guard
      saveEncrypted(licenseFilePath, { activationNumber: key, expiryDate: r.expiryDate }, id.machineHash);
      writeLastRun(SHARED_SECRET, id.machineId, new Date());
      return { valid: true, license: license(r) };
    },

    /**
     * Algorithm 4 — startup check. Returns:
     *   { ok:true,  license }                  → already activated & valid → go to dashboard
     *   { ok:false, activated:false }          → never activated → show activation screen
     *   { ok:false, activated:true, reason }   → expired / tampered / clock-rollback
     */
    checkStartup() {
      const id = getMachineIdentity();

      let record;
      try {
        record = loadEncrypted(licenseFilePath, id.machineHash);
      } catch {
        return { ok: false, activated: false, reason: 'Not activated' };
      }

      const r = verify(record.activationNumber, id.machineId);
      if (!r.valid) return { ok: false, activated: true, reason: r.reason };

      // ── Day-granularity clock-tamper guard (BOTH directions) ──────────────────
      // verify() above already enforces the license window (before start / after expiry).
      // Here we compare today against the HWM — the furthest day the app has ever
      // legitimately reached (newest tamper-proof stamp across all persisted locations):
      //
      //   A1 (backward): today < HWM            → rollback to dodge expiry.
      //   A2 (forward) : today > HWM + GAP_DAYS → clock set too far ahead.
      //
      // CRITICAL — recovery without poisoning: while blocked we deliberately do NOT
      // advance the HWM. So when the user restores the real date (verified on their
      // phone), today lands back inside [HWM … HWM+GAP] ∩ license-window and the app
      // unlocks automatically — no re-activation. The HWM only ever moves forward on a
      // clean pass, which is what makes both the backward- and forward-tamper recovery
      // scenarios work. Day granularity avoids false trips from sub-day NTP/timezone sync.
      const now = new Date();
      const todayStr = today();
      const hwmMs = readLastRun(SHARED_SECRET, id.machineId);
      const hwmDate = hwmMs !== null ? localDateStr(new Date(hwmMs)) : null;
      const guard = evaluateClockGuard(todayStr, hwmDate, MAX_FORWARD_GAP_DAYS);
      if (guard) {
        return { ok: false, activated: true, reason: guard.reason,
                 lastValidDate: guard.lastValidDate, expiryDate: r.expiryDate };
      }
      // Passed every guard → advance the HWM. This is the ONLY place it advances; it is
      // never advanced while blocked, so no tampering can poison the recovery window.
      writeLastRun(SHARED_SECRET, id.machineId, now);

      return { ok: true, activated: true, license: license(r) };
    },

    /**
     * Layer C — OPTIONAL online clock anchor. Opportunistic and best-effort: when the
     * machine has internet, compare the system clock to trusted UTC. It is AUTHORITATIVE:
     *   • clock within tolerance → genuine real time → resync HWM forward to it
     *       (self-heals a user who was legitimately away longer than MAX_FORWARD_GAP),
     *       returns { checked:true, ok:true }.
     *   • clock off by > tolerance → real tampering in either direction → returns
     *       { checked:true, ok:false, reason } and does NOT touch the HWM.
     *   • no internet / no answer → { checked:false } and the caller keeps the offline
     *       result, so the app stays fully usable offline.
     */
    async verifyClockOnline() {
      // Fast skip when the OS reports no connectivity — zero startup penalty offline.
      try {
        const { net } = require('electron');
        if (net && typeof net.isOnline === 'function' && net.isOnline() === false) {
          return { checked: false };
        }
      } catch (_) { /* not in electron (e.g. tests) → just try the fetch */ }

      let trustedMs = null;
      try { trustedMs = await fetchTrustedTimeMs(2000); } catch (_) { trustedMs = null; }
      if (trustedMs === null) return { checked: false };

      const id = getMachineIdentity();
      const sysMs = Date.now();
      const diff = sysMs - trustedMs;
      if (Math.abs(diff) > ONLINE_TOLERANCE_MS) {
        const days = Math.max(1, Math.round(Math.abs(diff) / 86400000));
        const dir = diff > 0 ? 'ahead of' : 'behind';
        return {
          checked: true,
          ok: false,
          reason: `System clock is ${dir} the real time by about ${days} day(s). ` +
                  'Set the correct date & time, then click “Try Again”.',
        };
      }
      // Clock is trustworthy → stamp the HWM forward to the verified real time so a
      // legitimate long absence can never trip the offline forward-gap guard again.
      writeLastRun(SHARED_SECRET, id.machineId, new Date(trustedMs));
      return { checked: true, ok: true };
    },

    /** Read-only license info for the dashboard (no clock stamping). */
    getLicenseInfo() {
      const id = getMachineIdentity();
      let record;
      try {
        record = loadEncrypted(licenseFilePath, id.machineHash);
      } catch {
        return { valid: false, reason: 'Not activated' };
      }
      const r = verify(record.activationNumber, id.machineId);
      return r.valid ? { valid: true, license: license(r) } : { valid: false, reason: r.reason };
    },

    /** Return the raw stored activation number (for the dashboard JSON panel). */
    getSavedKey() {
      const id = getMachineIdentity();
      try {
        return loadEncrypted(licenseFilePath, id.machineHash).activationNumber || null;
      } catch {
        return null;
      }
    },

    /** Delete the stored license (reset for testing a different key). */
    deleteLicense() {
      return remove(licenseFilePath);
    },
  };
}

module.exports = { createLicenseManager, evaluateClockGuard, addDaysStr, MAX_FORWARD_GAP_DAYS };
