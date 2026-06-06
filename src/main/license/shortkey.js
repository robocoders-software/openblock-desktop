// ─────────────────────────────────────────────────────────────────────────────
// Short activation key — HMAC, machine-bound, expiring.
//
// The key is intentionally tiny so a human can read/type it:
//
//   binary (10 bytes) = [ expiryDays : uint16 ][ HMAC : 8 bytes ]
//   activation_key    = Base32(binary)            → 16 chars
//                       grouped as XXXXX-XXXXX-XXXXX-X
//
//   HMAC = HMAC-SHA256(secret, MachineID | expiryDays)[0..8]
//
// The machine hash is NOT carried in the key — the offline PC recomputes its
// own Machine ID (Algorithm 1) and re-derives the HMAC. So the key stays short
// while remaining bound to one machine and tamper-proof.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { base32Encode, base32Decode, groupChars } = require('./base32');

const EPOCH = Date.UTC(2025, 0, 1);   // 2025-01-01
const HMAC_BYTES = 8;                 // 64-bit truncated tag
const PAYLOAD_BYTES = 2 + HMAC_BYTES; // 10 bytes → exactly 16 Base32 chars

// ── date <-> day counter ─────────────────────────────────────────────────────
function dateToExpiryDays(dateStr) {
  const ms = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(ms)) throw new Error('Invalid date: ' + dateStr);
  return Math.floor((ms - EPOCH) / 86400000);
}
function expiryDaysToDate(days) {
  return new Date(EPOCH + days * 86400000).toISOString().split('T')[0];
}

// ── core HMAC ─────────────────────────────────────────────────────────────────
function computeMac(secret, machineId, expiryDays) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${machineId.toUpperCase()}|${expiryDays}`, 'utf8')
    .digest()
    .subarray(0, HMAC_BYTES);
}

/**
 * Portal side — produce a short activation key for a given machine + expiry.
 * @param {{ machineId:string, expiryDate:string, secret:Buffer }} args
 * @returns {{ activationKey:string, activationKeyGrouped:string, expiryDate:string }}
 */
function generateActivationKey({ machineId, expiryDate, secret }) {
  const days = dateToExpiryDays(expiryDate);
  if (days < 0) throw new Error('Expiry date must be after 2025-01-01');
  if (days > 0xffff) throw new Error('Expiry date too far in the future');

  const payload = Buffer.alloc(PAYLOAD_BYTES);
  payload.writeUInt16BE(days, 0);
  computeMac(secret, machineId, days).copy(payload, 2);

  const key = base32Encode(payload); // 16 chars
  return {
    activationKey: key,
    activationKeyGrouped: groupChars(key, 5),
    expiryDate: expiryDaysToDate(days),
  };
}

/**
 * App side — verify a key against THIS machine and check expiry.
 * @param {string} rawKey
 * @param {{ machineId:string, secret:Buffer, now?:Date }} ctx
 * @returns {{ valid:boolean, reason?:string, expiryDate?:string, licenseType?:string }}
 */
function verifyActivationKey(rawKey, { machineId, secret, now }) {
  let payload;
  try {
    payload = base32Decode(rawKey);
  } catch (e) {
    return { valid: false, reason: 'Invalid key format: ' + e.message };
  }
  if (payload.length < PAYLOAD_BYTES) {
    return { valid: false, reason: 'Activation key is incomplete' };
  }

  const days = payload.readUInt16BE(0);
  const mac = payload.subarray(2, 2 + HMAC_BYTES);
  const expected = computeMac(secret, machineId, days);

  // constant-time compare → rejects tampered keys and keys for other machines
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) {
    return { valid: false, reason: 'Invalid key — not for this machine or tampered' };
  }

  const expiryDate = expiryDaysToDate(days);
  const today = (now || new Date()).toISOString().split('T')[0];
  if (today > expiryDate) {
    return { valid: false, reason: 'License expired on ' + expiryDate, expiryDate };
  }

  return { valid: true, expiryDate, licenseType: 'ANNUAL' };
}

module.exports = {
  EPOCH,
  HMAC_BYTES,
  dateToExpiryDays,
  expiryDaysToDate,
  generateActivationKey,
  verifyActivationKey,
};
