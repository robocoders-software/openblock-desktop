// ─────────────────────────────────────────────────────────────────────────────
// Base32 codec (RFC 4648, no padding) over arbitrary bytes.
//
// Used by Algorithm 2 Step 5 (encode license_package bytes) and
// Algorithm 3 Step 2 (decode activation_key back to bytes).
//
// The activation key is therefore composed ONLY of the uppercase alphabet
// below — so normalizing to uppercase and stripping separators is lossless.
// ─────────────────────────────────────────────────────────────────────────────

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const LOOKUP = (() => {
  const m = {};
  for (let i = 0; i < ALPHABET.length; i++) m[ALPHABET[i]] = i;
  return m;
})();

/**
 * Encode a Buffer/Uint8Array into an unpadded Base32 string.
 * @param {Buffer|Uint8Array} bytes
 * @returns {string}
 */
function base32Encode(bytes) {
  const buf = Buffer.from(bytes);
  let out = '';
  let bits = 0;       // accumulator
  let bitCount = 0;   // number of valid bits in accumulator

  for (let i = 0; i < buf.length; i++) {
    bits = (bits << 8) | buf[i];
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += ALPHABET[(bits >>> bitCount) & 31];
    }
  }
  // flush remaining bits (left-aligned), if any
  if (bitCount > 0) {
    out += ALPHABET[(bits << (5 - bitCount)) & 31];
  }
  return out;
}

/**
 * Decode an unpadded Base32 string back into a Buffer.
 * Input may contain dashes/spaces/lowercase — they are normalized away.
 * @param {string} str
 * @returns {Buffer}
 */
function base32Decode(str) {
  const clean = String(str).replace(/[\s-]/g, '').toUpperCase();
  const out = [];
  let bits = 0;
  let bitCount = 0;

  for (const ch of clean) {
    const val = LOOKUP[ch];
    if (val === undefined) throw new Error(`Invalid Base32 character: "${ch}"`);
    bits = (bits << 5) | val;
    bitCount += 5;
    if (bitCount >= 8) {
      bitCount -= 8;
      out.push((bits >>> bitCount) & 0xff);
    }
  }
  // Enforce CANONICAL encoding: the leftover bits (which don't form a full byte
  // and are discarded) MUST be zero. The encoder always produces zero padding,
  // so a non-zero leftover means the last character was altered to a value that
  // differs only in the unused trailing bit(s) — e.g. C(00010) → D(00011). Those
  // would otherwise decode to identical bytes and slip past the tamper seal.
  if (bitCount > 0 && (bits & ((1 << bitCount) - 1)) !== 0) {
    throw new Error('Non-canonical Base32 (trailing padding bits set)');
  }
  return Buffer.from(out);
}

/**
 * Split a string into dash-separated groups of N (default 5).
 * @param {string} str
 * @param {number} size
 * @returns {string}
 */
function groupChars(str, size = 5) {
  const re = new RegExp(`.{1,${size}}`, 'g');
  return str.match(re).join('-');
}

module.exports = { base32Encode, base32Decode, groupChars, ALPHABET };
