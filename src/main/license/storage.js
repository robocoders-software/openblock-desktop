// ─────────────────────────────────────────────────────────────────────────────
// Encrypted local license store (Algorithm 3 Step 8 + Algorithm 4 state).
//
// Stores { activationKey, expiryDate } in an AES-256-GCM blob.
// The encryption key is derived from the machine hash, so the file is also
// machine-bound at the storage layer — a copied license.dat will not decrypt
// on a different machine.
//
// File format (license.dat), binary, concatenated:
//   [12 bytes IV][16 bytes GCM tag][ciphertext]
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');

const ALGO = 'aes-256-gcm';
const KDF_SALT = 'offline-license-store-v1';

function deriveKey(machineHash) {
  return crypto.createHash('sha256').update(KDF_SALT + ':' + machineHash).digest();
}

/**
 * Encrypt and write the license record to disk.
 * @param {string} filePath
 * @param {object} record  e.g. { activationKey, expiryDate }
 * @param {string} machineHash  full hex machine hash (encryption key material)
 */
function saveEncrypted(filePath, record, machineHash) {
  const key = deriveKey(machineHash);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const plaintext = Buffer.from(JSON.stringify(record), 'utf8');
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  fs.writeFileSync(filePath, Buffer.concat([iv, tag, ciphertext]));
}

/**
 * Read and decrypt the license record.
 * Throws if the file is missing, tampered, or from another machine.
 * @returns {object} the stored record
 */
function loadEncrypted(filePath, machineHash) {
  if (!fs.existsSync(filePath)) throw new Error('No license file found');
  const blob = fs.readFileSync(filePath);
  if (blob.length < 28) throw new Error('License file is corrupt');

  const iv = blob.subarray(0, 12);
  const tag = blob.subarray(12, 28);
  const ciphertext = blob.subarray(28);

  const key = deriveKey(machineHash);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  let plaintext;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new Error('License file could not be decrypted (tampered or wrong machine)');
  }
  return JSON.parse(plaintext.toString('utf8'));
}

function exists(filePath) {
  return fs.existsSync(filePath);
}

/**
 * Delete the stored license file, if present.
 * @returns {boolean} true if a file was removed, false if none existed.
 */
function remove(filePath) {
  if (!fs.existsSync(filePath)) return false;
  fs.unlinkSync(filePath);
  return true;
}

module.exports = { saveEncrypted, loadEncrypted, exists, remove };
