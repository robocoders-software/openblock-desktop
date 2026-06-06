// Shared HMAC secret — used to verify license keys.
// Both apps must use the same secret.
//
// Step 1: cd desktop-app && npm install
// Step 2: node generate-keys.js
// Step 3: paste the SHARED SECRET below

const SHARED_SECRET_B64 = '/im9hOzLa2sEBuP0JguySRxequ6jggVEu5sQzMWt1JU=';

if (SHARED_SECRET_B64.startsWith('REPLACE')) {
  console.error('\n[LICENSE] ERROR: Shared secret not configured.');
  console.error('[LICENSE] Run: node generate-keys.js  and paste the secret into desktop-app/src/keys.js\n');
  process.exit(1);
}

const SHARED_SECRET = Buffer.from(SHARED_SECRET_B64, 'base64');

// This build's official license/deployment number. The activation key must
// carry this same number or activation is rejected ("not for this software").
// Change it per customer/batch; bump it to invalidate previously issued keys.
const LICENSE_NUMBER = 11111;

module.exports = { SHARED_SECRET, LICENSE_NUMBER };
