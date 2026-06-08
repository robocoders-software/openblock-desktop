// ─────────────────────────────────────────────────────────────────────────────
// Shared HMAC secret + license number baked into this build.
//
// The activation key is generated (admin portal) and verified (here) with the
// SAME secret. Keep this secret private — anyone who extracts it can mint keys.
//
// To rotate: generate a new 32-byte base64 secret
//   node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// and bump LICENSE_NUMBER to invalidate previously issued keys.
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_SECRET_B64 = 'uZXHVDLXN7WDOOf12G+z+bKf3xhDhTvIZdhcsGcRSxQ=';

const SHARED_SECRET = Buffer.from(SHARED_SECRET_B64, 'base64');

// This build's official license/deployment number. The activation key must carry
// this same number or activation is rejected. Change per customer/batch.
// Range: 0 .. 99999 (5-digit, matches the 21-char key format).
const LICENSE_NUMBER = 10001;

module.exports = { SHARED_SECRET, LICENSE_NUMBER };
