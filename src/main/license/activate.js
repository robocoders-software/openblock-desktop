// ─────────────────────────────────────────────────────────────────────────────
// Algorithm 3 — Activation (School PC), encrypted activation number.
//
//   1. Normalize  — strip dashes/spaces, uppercase
//   2. Recompute  — this machine's Machine ID (Algorithm 1)
//   3. Decrypt    — activation number → { machineId, startDate, expiryDate,
//                   licenseNumber }; tamper seal checked inside
//   4. Bind check — key's machineId must equal this machine's machineId
//   5. Date check — today must be within [startDate, expiryDate]
//   6. Store      — save record encrypted (license.dat), machine-hash bound
//   7. Timeguard  — seed anti-rollback timestamps across all locations
//   8. Success
// ─────────────────────────────────────────────────────────────────────────────

const { readActivationNumber } = require('./activation');
const { getMachineIdentity } = require('./machine');
const { saveEncrypted } = require('./storage');
const { writeLastRun } = require('./timeguard');

/** Strip separators / whitespace and uppercase. */
function normalizeKey(raw) {
  return String(raw).replace(/[\s-]/g, '').toUpperCase();
}

/**
 * Full Algorithm 3.
 * @param {object} args
 * @param {string} args.activationKey   raw 45-char activation number (dashes OK)
 * @param {Buffer} args.secret
 * @param {string} args.licenseFilePath
 * @param {object} [args.identity]      override machine identity (for tests)
 * @param {Date}   [args.now]           override clock (for tests)
 * @returns {{ valid:boolean, reason?:string, license?:object }}
 */
function activate({ activationKey, secret, licenseFilePath, identity, now }) {
  const id = identity || getMachineIdentity();
  const key = normalizeKey(activationKey);
  const today = (now || new Date()).toISOString().split('T')[0];

  // Step 3 — decrypt + verify tamper seal
  const result = readActivationNumber(key, secret);
  if (!result.valid) return { valid: false, reason: result.reason };

  // Step 4 — machine binding
  if (result.machineId !== id.machineId) {
    return { valid: false, reason: 'License is not for this machine' };
  }

  // Step 5 — date range
  if (today < result.startDate) {
    return { valid: false, reason: 'License not yet active — starts ' + result.startDate };
  }
  if (today > result.expiryDate) {
    return { valid: false, reason: 'License expired on ' + result.expiryDate };
  }

  // Step 6 — store encrypted (bound to this machine's hash)
  saveEncrypted(licenseFilePath, {
    activationKey: key,
    machineId:     result.machineId,
    startDate:     result.startDate,
    expiryDate:    result.expiryDate,
    licenseNumber: result.licenseNumber,
  }, id.machineHash);

  // Step 7 — seed the anti-rollback time guard
  writeLastRun(secret, id.machineId, now || new Date());

  // Step 8 — success
  return {
    valid: true,
    license: {
      machineId:     result.machineId,
      startDate:     result.startDate,
      expiryDate:    result.expiryDate,
      licenseNumber: result.licenseNumber,
    },
  };
}

module.exports = { normalizeKey, activate };
