// ─────────────────────────────────────────────────────────────────────────────
// Algorithm 1 — Generate Machine ID (single deterministic source)
//
//   guid         = HKLM\SOFTWARE\Microsoft\Cryptography  MachineGuid
//   machine_hash = SHA256(guid)                 (full 64-char hex)
//   machine_id   = First16(machine_hash)        (shown to the installer)
//
// ONE source, no fallback ladder. The Windows MachineGuid is a GUID written
// once at OS install: present on every Windows PC, unique per installation,
// readable by a standard (non-admin) user, and — unlike CIM/PowerShell hardware
// queries — reliable on locked-down school PCs. Read via reg.exe so it does not
// depend on PowerShell being enabled.
//
// If the MachineGuid cannot be read, we THROW rather than fall back to a shared
// constant — a missing MachineGuid is an abnormal system, and silently issuing
// the same Machine ID to many PCs would let one key activate them all.
//
// Trade-off (by design): MachineGuid is tied to the OS installation, so an
// OS reinstall / re-image changes it and that PC must be re-activated. Image
// labs with `sysprep /generalize` so each clone gets its own MachineGuid.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const { execFileSync } = require('child_process');

const REG_PATH = 'HKLM\\SOFTWARE\\Microsoft\\Cryptography';
const REG_VALUE = 'MachineGuid';

// ── The single source: Windows MachineGuid ───────────────────────────────────

/**
 * Read the Windows MachineGuid from the registry via reg.exe.
 * `/reg:64` forces the 64-bit view so a 32-bit process reads the same value.
 * @returns {string} the lowercase GUID, e.g. "f1d2c3b4-...-abc123456789"
 * @throws if the value cannot be read (no silent fallback by design)
 */
function readMachineGuid() {
  let out;
  try {
    out = execFileSync(
      'reg',
      ['query', REG_PATH, '/v', REG_VALUE, '/reg:64'],
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
  } catch (e) {
    throw new Error(
      'Could not read Windows MachineGuid (reg.exe failed). This environment is not supported. '
      + (e && e.message ? e.message : '')
    );
  }
  // Output line:  "    MachineGuid    REG_SZ    <guid>"
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/);
  const guid = m && m[1] ? m[1].trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) {
    throw new Error('Windows MachineGuid is missing or malformed — environment not supported.');
  }
  return guid;
}

// ── Pure logic (testable with a fixed guid) ──────────────────────────────────

/** SHA256(guid) as lowercase hex — the full machine_hash. */
function hashFingerprint(guid) {
  return crypto.createHash('sha256').update(String(guid), 'utf8').digest('hex');
}

/** First 16 chars of the machine hash, uppercased — the displayed Machine ID. */
function machineIdFromHash(machineHash) {
  return machineHash.substring(0, 16).toUpperCase();
}

// ── Whole Algorithm 1 for the current machine (memoized) ─────────────────────

let _cached = null;

/**
 * @returns {{machineGuid:string, fingerprint:string, machineHash:string, machineId:string,
 *            hardware:{machineGuid:string}}}
 */
function getMachineIdentity() {
  if (_cached) return _cached;
  const guid = readMachineGuid();
  const machineHash = hashFingerprint(guid);
  const machineId = machineIdFromHash(machineHash);
  _cached = {
    machineGuid: guid,
    fingerprint: guid,          // the single source string
    machineHash,
    machineId,
    hardware: { machineGuid: guid }, // kept for diagnostics / backward compatibility
  };
  return _cached;
}

module.exports = {
  readMachineGuid,
  hashFingerprint,
  machineIdFromHash,
  getMachineIdentity,
};
