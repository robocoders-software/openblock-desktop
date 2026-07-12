// ─────────────────────────────────────────────────────────────────────────────
// Algorithm 1 — Generate Machine ID (single deterministic source per platform)
//
//   fingerprint  = per-platform stable machine identifier (see below)
//   machine_hash = SHA256(fingerprint)             (full 64-char hex)
//   machine_id   = First16(machine_hash)           (shown to the installer)
//
// ONE source per platform, no fallback ladder. Each source is an identifier that
// the OS writes once at install time: present on every machine, unique per
// installation, and readable by a standard (non-admin) user — unlike CIM/
// hardware queries which are unreliable on locked-down machines.
//
//   Windows  HKLM\SOFTWARE\Microsoft\Cryptography  MachineGuid   (via reg.exe,
//            so it does not depend on PowerShell being enabled)
//   macOS    IOPlatformUUID from IOPlatformExpertDevice          (via ioreg)
//   Linux    /etc/machine-id  (falls back to /var/lib/dbus/machine-id)
//
// If the source cannot be read, we THROW rather than fall back to a shared
// constant — a missing identifier is an abnormal system, and silently issuing
// the same Machine ID to many PCs would let one key activate them all.
//
// Trade-off (by design): each source is tied to the OS installation, so an
// OS reinstall / re-image changes it and that machine must be re-activated.
// Image labs with `sysprep /generalize` (Windows) or clear /etc/machine-id
// before imaging (Linux) so each clone gets its own identifier.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const fs = require('fs');
const { execFileSync } = require('child_process');

const REG_PATH = 'HKLM\\SOFTWARE\\Microsoft\\Cryptography';
const REG_VALUE = 'MachineGuid';

// ── The single source, per platform ──────────────────────────────────────────

/**
 * Windows: read the MachineGuid from the registry via reg.exe.
 * `/reg:64` forces the 64-bit view so a 32-bit process reads the same value.
 * @returns {string} lowercase GUID, e.g. "f1d2c3b4-...-abc123456789"
 */
function readWindowsGuid() {
  const out = execFileSync(
    'reg',
    ['query', REG_PATH, '/v', REG_VALUE, '/reg:64'],
    { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
  );
  // Output line:  "    MachineGuid    REG_SZ    <guid>"
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9A-Fa-f-]+)/);
  const guid = m && m[1] ? m[1].trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(guid)) {
    throw new Error('Windows MachineGuid is missing or malformed.');
  }
  return guid;
}

/**
 * macOS: read the IOPlatformUUID from the I/O Registry via ioreg.
 * @returns {string} lowercase UUID
 */
function readMacUuid() {
  const out = execFileSync(
    'ioreg',
    ['-rd1', '-c', 'IOPlatformExpertDevice'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  );
  // Output line:  "    "IOPlatformUUID" = "F1D2C3B4-...-ABC123456789""
  const m = out.match(/"IOPlatformUUID"\s*=\s*"([0-9A-Fa-f-]+)"/);
  const uuid = m && m[1] ? m[1].trim().toLowerCase() : '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid)) {
    throw new Error('macOS IOPlatformUUID is missing or malformed.');
  }
  return uuid;
}

/**
 * Linux: read /etc/machine-id (systemd), falling back to the D-Bus machine-id.
 * @returns {string} lowercase 32-char hex string
 */
function readLinuxMachineId() {
  const paths = ['/etc/machine-id', '/var/lib/dbus/machine-id'];
  let raw = '';
  for (const p of paths) {
    try {
      raw = fs.readFileSync(p, 'utf8').trim().toLowerCase();
      if (raw) break;
    } catch {
      // try the next location
    }
  }
  if (!/^[0-9a-f]{32}$/.test(raw)) {
    throw new Error('Linux machine-id is missing or malformed.');
  }
  return raw;
}

/**
 * Read this machine's stable fingerprint using the platform's single source.
 * @returns {string} a lowercase, stable-per-install identifier
 * @throws if the value cannot be read (no silent fallback by design)
 */
function readMachineFingerprint() {
  try {
    switch (process.platform) {
    case 'win32':
      return readWindowsGuid();
    case 'darwin':
      return readMacUuid();
    case 'linux':
      return readLinuxMachineId();
    default:
      throw new Error(`Unsupported platform: ${process.platform}`);
    }
  } catch (e) {
    throw new Error(
      'Could not read a stable machine identifier for this environment. '
      + (e && e.message ? e.message : '')
    );
  }
}

// Backward-compatible alias — some callers/tests referenced readMachineGuid.
const readMachineGuid = readMachineFingerprint;

// ── Pure logic (testable with a fixed fingerprint) ───────────────────────────

/** SHA256(fingerprint) as lowercase hex — the full machine_hash. */
function hashFingerprint(fingerprint) {
  return crypto.createHash('sha256').update(String(fingerprint), 'utf8').digest('hex');
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
  const fingerprint = readMachineFingerprint();
  const machineHash = hashFingerprint(fingerprint);
  const machineId = machineIdFromHash(machineHash);
  _cached = {
    machineGuid: fingerprint,        // kept for backward compatibility / diagnostics
    fingerprint,                     // the single source string
    machineHash,
    machineId,
    hardware: { machineGuid: fingerprint },
  };
  return _cached;
}

module.exports = {
  readMachineFingerprint,
  readMachineGuid,
  hashFingerprint,
  machineIdFromHash,
  getMachineIdentity,
};
