// ─────────────────────────────────────────────────────────────────────────────
// Algorithm 4 — Startup Validation (runs every launch).
//
//   1. Load + decrypt license.dat (machine-hash bound)
//   2. Re-decrypt activation number → { machineId, startDate, expiryDate,
//      licenseNumber }; tamper seal re-checked inside
//   3. Machine binding check  → else block
//   4. Date range check       → else block
//   5. Clock rollback check   → else block
//   6. Update last_run_time across all locations
//   7. Launch application (caller proceeds on { ok:true })
// ─────────────────────────────────────────────────────────────────────────────

const { readActivationNumber } = require('./activation');
const { getMachineIdentity } = require('./machine');
const { loadEncrypted } = require('./storage');
const { readLastRun, writeLastRun } = require('./timeguard');

function block(reason) {
  return { ok: false, reason };
}

/**
 * @param {object} args
 * @param {Buffer} args.secret
 * @param {string} args.licenseFilePath
 * @param {object} [args.identity]  override machine identity (for tests)
 * @param {Date}   [args.now]       override clock (for tests)
 * @returns {{ ok:boolean, reason?:string, license?:object }}
 */
function validateStartup({ secret, licenseFilePath, identity, now }) {
  const currentTime = now || new Date();
  const id = identity || getMachineIdentity();

  // Step 1 — load + decrypt (file is itself machine-bound via AES-GCM key)
  let record;
  try {
    record = loadEncrypted(licenseFilePath, id.machineHash);
  } catch (e) {
    return block(e.message);
  }

  // Step 2 — re-decrypt activation number + re-verify tamper seal
  const result = readActivationNumber(record.activationKey, secret);
  if (!result.valid) return block('Block startup — ' + result.reason);

  // Step 3 — machine binding
  if (result.machineId !== id.machineId) {
    return block('Block startup — License is not for this machine');
  }

  // Step 4 — date range
  const today = currentTime.toISOString().split('T')[0];
  if (today < result.startDate) {
    return block('Block startup — License not yet active');
  }
  if (today > result.expiryDate) {
    return block('Block startup — License expired on ' + result.expiryDate);
  }

  // Step 5 — clock rollback (newest stamp across ALL persisted locations)
  const lastRunMs = readLastRun(secret, id.machineId);
  if (lastRunMs !== null && currentTime.getTime() < lastRunMs) {
    return block('Block startup — clock manipulation detected');
  }

  // Step 6 — stamp current time (never go backwards)
  const stamp = lastRunMs !== null
    ? new Date(Math.max(currentTime.getTime(), lastRunMs))
    : currentTime;
  writeLastRun(secret, id.machineId, stamp);

  // Step 7 — OK to launch
  return {
    ok: true,
    license: {
      machineId:     result.machineId,
      startDate:     result.startDate,
      expiryDate:    result.expiryDate,
      licenseNumber: result.licenseNumber,
    },
  };
}

module.exports = { validateStartup };
