// ─────────────────────────────────────────────────────────────────────────────
// License manager — the single place the desktop app talks to for licensing.
//
// Ties together:
//   • activation.js  — verify/decrypt the 32-char activation number
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
const { readLastRun, writeLastRun } = require('./timeguard');

// Today's LOCAL calendar date as YYYY-MM-DD. We must use local time (not
// toISOString(), which is UTC) so the comparison matches the calendar dates the
// installer picked — otherwise a timezone ahead of UTC can block/expire a day off.
function today() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
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

      // clock-rollback guard (newest stamp across all persisted locations)
      const now = new Date();
      const lastRunMs = readLastRun(SHARED_SECRET, id.machineId);
      if (lastRunMs !== null && now.getTime() < lastRunMs) {
        return { ok: false, activated: true, reason: 'Clock manipulation detected' };
      }
      writeLastRun(SHARED_SECRET, id.machineId, now);

      return { ok: true, activated: true, license: license(r) };
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

module.exports = { createLicenseManager };
