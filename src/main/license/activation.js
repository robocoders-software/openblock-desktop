// ─────────────────────────────────────────────────────────────────────────────
// Self-contained activation number — 3 methods.
//
//   1. prepareMachineId()                    → "452C0D63ADF85A3E"  (16 hex)
//   2. generateActivationNumber({...})       → "K7QML-3F8AZ-…"     (32 chars)
//   3. readActivationNumber(number, secret)  → { machineId, startDate,
//                                                expiryDate, licenseNumber }
//
// All four values are encrypted INSIDE the number. To keep it short, only the
// FIRST 4 BYTES (8 hex chars) of the Machine ID are stored — that's enough to
// tell school PCs apart, and forgery is blocked by the tag regardless of length.
// The app binds by comparing its own Machine ID's first 8 hex chars to the
// recovered `machineId`.
//
//   plaintext (12 bytes)
//     [0..4)   machineId(4)   first 4 bytes of the Machine ID (8 hex chars)
//     [4..6)   startDays      uint16   (days since 2025-01-01)
//     [6..8)   expiryDays     uint16
//     [8..12)  licenseNumber  uint32
//
//   keys   = SHA256(secret | "enc"/"mac")
//   tag    = HMAC(macKey, plaintext)[0..8]   ← tamper seal AND the IV
//   cipher = AES-256-CTR(encKey, iv=tag).encrypt(plaintext)
//   wire (20 bytes) = tag(8) + cipher(12)
//   activation number = Base32(wire), grouped in 5s  → 32 characters
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { base32Encode, base32Decode, groupChars } = require('./base32');
const { getMachineIdentity } = require('./machine');

const EPOCH = Date.UTC(2025, 0, 1);   // day 0 = 2025-01-01
const TAG_BYTES = 8;
const MACHINE_ID_BYTES = 4;           // store first 4 bytes (8 hex chars)
const PLAINTEXT_BYTES = MACHINE_ID_BYTES + 2 + 2 + 4; // 12
const WIRE_BYTES = TAG_BYTES + PLAINTEXT_BYTES;       // 20

// ── small helpers ─────────────────────────────────────────────────────────────
function dateToDays(dateStr) {
  const ms = Date.parse(dateStr + 'T00:00:00Z');
  if (Number.isNaN(ms)) throw new Error('Invalid date: ' + dateStr);
  const d = Math.floor((ms - EPOCH) / 86400000);
  if (d < 0 || d > 0xffff) throw new Error('Date out of range (2025-01-01 .. ~2204): ' + dateStr);
  return d;
}
function daysToDate(days) {
  return new Date(EPOCH + days * 86400000).toISOString().split('T')[0];
}

function deriveKeys(secret) {
  const mk = (label) =>
    crypto.createHash('sha256').update(Buffer.concat([secret, Buffer.from(label)])).digest();
  return { encKey: mk('enc'), macKey: mk('mac') };
}
function tagOf(macKey, plaintext) {
  return crypto.createHmac('sha256', macKey).update(plaintext).digest().subarray(0, TAG_BYTES);
}
function ctr(encKey, tag, input) {
  const iv = Buffer.concat([tag, Buffer.alloc(16 - TAG_BYTES)]); // tag doubles as the 16-byte CTR IV
  const c = crypto.createCipheriv('aes-256-ctr', encKey, iv);
  return Buffer.concat([c.update(input), c.final()]);
}

// ── Method 1 ──────────────────────────────────────────────────────────────────
/** Read this PC's hardware and return its 16-hex Machine ID. */
function prepareMachineId() {
  return getMachineIdentity().machineId;
}

// ── Method 2 ──────────────────────────────────────────────────────────────────
/**
 * Pack + encrypt all four values into a typeable activation number.
 * @param {object} a
 * @param {string} a.machineId      16 hex chars (only first 8 are stored)
 * @param {string} a.startDate      "YYYY-MM-DD"
 * @param {string} a.expiryDate     "YYYY-MM-DD"
 * @param {number} a.licenseNumber  integer 0 .. 4294967295
 * @param {Buffer} a.secret         shared secret
 * @returns {string} grouped activation number (32 chars)
 */
function generateActivationNumber({ machineId, startDate, expiryDate, licenseNumber, secret }) {
  const id = String(machineId).trim().toUpperCase();
  if (!/^[0-9A-F]{16}$/.test(id)) throw new Error('machineId must be 16 hex characters');
  if (!Number.isInteger(licenseNumber) || licenseNumber < 0 || licenseNumber > 0xffffffff) {
    throw new Error('licenseNumber must be an integer 0 .. 4294967295');
  }

  const plaintext = Buffer.alloc(PLAINTEXT_BYTES);
  Buffer.from(id, 'hex').copy(plaintext, 0, 0, MACHINE_ID_BYTES);  // first 4 bytes of the ID
  plaintext.writeUInt16BE(dateToDays(startDate), 4);
  plaintext.writeUInt16BE(dateToDays(expiryDate), 6);
  plaintext.writeUInt32BE(licenseNumber, 8);

  const { encKey, macKey } = deriveKeys(secret);
  const tag = tagOf(macKey, plaintext);
  const cipher = ctr(encKey, tag, plaintext);

  return groupChars(base32Encode(Buffer.concat([tag, cipher])), 5);
}

// ── Method 3 ──────────────────────────────────────────────────────────────────
/**
 * Decrypt an activation number back into all four values.
 * `machineId` is returned as 8 hex chars (the first 4 bytes that were stored).
 * @param {string} activationNumber  (dashes/spaces/case don't matter)
 * @param {Buffer} secret
 * @returns {{ valid:boolean, reason?:string, machineId?:string,
 *             startDate?:string, expiryDate?:string, licenseNumber?:number }}
 */
function readActivationNumber(activationNumber, secret) {
  let wire;
  try { wire = base32Decode(activationNumber); }
  catch (e) { return { valid: false, reason: 'Invalid format: ' + e.message }; }
  if (wire.length !== WIRE_BYTES) {
    return { valid: false, reason: 'Wrong length — not a valid activation number' };
  }

  const tag = wire.subarray(0, TAG_BYTES);
  const cipher = wire.subarray(TAG_BYTES);

  const { encKey, macKey } = deriveKeys(secret);
  const plaintext = ctr(encKey, tag, cipher);

  // tamper seal: recomputed tag must match (rejects edits, forgeries, wrong secret)
  const expected = tagOf(macKey, plaintext);
  if (!crypto.timingSafeEqual(tag, expected)) {
    return { valid: false, reason: 'Activation number is invalid or was modified' };
  }

  return {
    valid: true,
    machineId: plaintext.subarray(0, MACHINE_ID_BYTES).toString('hex').toUpperCase(), // 8 hex chars
    startDate: daysToDate(plaintext.readUInt16BE(4)),
    expiryDate: daysToDate(plaintext.readUInt16BE(6)),
    licenseNumber: plaintext.readUInt32BE(8),
  };
}

// ── Full policy check (decrypt + identity checks) ────────────────────────────
/**
 * Decrypt AND enforce the app's policy:
 *   • tamper seal must be valid (genuine key)
 *   • licenseNumber must equal the number baked into THIS software build
 *   • machineId (first 8 hex) must match this PC
 *
 * @param {string} activationNumber
 * @param {object} ctx
 * @param {Buffer} ctx.secret
 * @param {number} ctx.expectedLicenseNumber  the number stored in the exe
 * @param {string} [ctx.machineId]            this PC's full 16-hex Machine ID
 * @returns {{ valid:boolean, reason?:string, machineId?:string,
 *             startDate?:string, expiryDate?:string, licenseNumber?:number }}
 */
function verifyActivationNumber(activationNumber, { secret, expectedLicenseNumber, machineId }) {
  const r = readActivationNumber(activationNumber, secret);
  if (!r.valid) return r;

  // license number must match the one compiled into this software
  if (expectedLicenseNumber != null && r.licenseNumber !== expectedLicenseNumber) {
    return { valid: false, reason: 'This key was not issued for this software (license number mismatch)' };
  }

  // machine binding: compare the stored 8-hex prefix to this PC's
  if (machineId != null) {
    const localPrefix = String(machineId).trim().toUpperCase().slice(0, MACHINE_ID_BYTES * 2);
    if (r.machineId !== localPrefix) {
      return { valid: false, reason: 'This key is not for this machine' };
    }
  }

  return r;
}

module.exports = {
  prepareMachineId,
  generateActivationNumber,
  readActivationNumber,
  verifyActivationNumber,
  MACHINE_ID_BYTES,
};
