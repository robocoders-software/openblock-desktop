// ─────────────────────────────────────────────────────────────────────────────
// Algorithm 1 — Generate Machine ID (School PC)
//
//   fingerprint  = CPU_SERIAL | MOTHERBOARD_SERIAL | DISK_SERIAL | OS_TYPE
//   machine_hash = SHA256(fingerprint)            (full 64-char hex)
//   machine_id   = First16(machine_hash)          (shown to the installer)
//
// Machine ID is 16 hex chars (64 bits): readable enough to type into the
// portal, and the short HMAC activation key is bound to this exact value, so a
// license cannot be moved to another PC.
//
// Real hardware serials are read on Windows via PowerShell (Get-CimInstance),
// with a WMIC fallback. The pure logic (buildFingerprint / hashFingerprint)
// is separated from the I/O so it can be unit-tested with fixed inputs.
// ─────────────────────────────────────────────────────────────────────────────

const crypto = require('crypto');
const os = require('os');
const { execSync } = require('child_process');

// ── Hardware readers (Windows) ───────────────────────────────────────────────

function runPowerShell(cmd) {
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -Command "${cmd}"`,
      { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    return out.trim();
  } catch {
    return '';
  }
}

// Some CIM queries return several lines (e.g. multiple disks). Pick the first
// non-empty, meaningful value and normalize whitespace.
function firstMeaningful(raw) {
  if (!raw) return '';
  for (const line of raw.split(/\r?\n/)) {
    const v = line.trim();
    if (v && !/^(to be filled|default string|none|n\/a|0+)$/i.test(v)) return v;
  }
  return '';
}

function readCpuSerial() {
  return firstMeaningful(
    runPowerShell('(Get-CimInstance Win32_Processor).ProcessorId')
  ) || 'UNKNOWN_CPU';
}

function readMotherboardSerial() {
  return firstMeaningful(
    runPowerShell('(Get-CimInstance Win32_BaseBoard).SerialNumber')
  ) || 'UNKNOWN_MB';
}

function readDiskSerial() {
  return firstMeaningful(
    runPowerShell('Get-CimInstance Win32_DiskDrive | Select-Object -ExpandProperty SerialNumber')
  ) || 'UNKNOWN_DISK';
}

function readOsType() {
  return os.arch();
}

/**
 * Read all hardware identifiers for this machine.
 * @returns {{cpu:string, motherboard:string, disk:string, os:string}}
 */
function readHardwareInfo() {
  return {
    cpu: readCpuSerial(),
    motherboard: readMotherboardSerial(),
    disk: readDiskSerial(),
    os: readOsType(),
  };
}

// ── Pure logic (testable without hardware) ───────────────────────────────────

/**
 * Build the fingerprint string from hardware info (Algorithm 1, step 5).
 * @param {{cpu:string, motherboard:string, disk:string, os:string}} hw
 * @returns {string}
 */
function buildFingerprint(hw) {
  return `${hw.cpu}|${hw.motherboard}|${hw.disk}|${hw.os}`;
}

/** SHA256(fingerprint) as lowercase hex — the full machine_hash. */
function hashFingerprint(fingerprint) {
  return crypto.createHash('sha256').update(fingerprint, 'utf8').digest('hex');
}

/** First 16 chars of the machine hash, uppercased — the displayed Machine ID. */
function machineIdFromHash(machineHash) {
  return machineHash.substring(0, 16).toUpperCase();
}

// ── Convenience: do the whole Algorithm 1 for the current machine ────────────

/**
 * @returns {{hardware:object, fingerprint:string, machineHash:string, machineId:string}}
 */
function getMachineIdentity() {
  const hardware = readHardwareInfo();
  const fingerprint = buildFingerprint(hardware);
  const machineHash = hashFingerprint(fingerprint);
  const machineId = machineIdFromHash(machineHash);
  return { hardware, fingerprint, machineHash, machineId };
}

module.exports = {
  readHardwareInfo,
  buildFingerprint,
  hashFingerprint,
  machineIdFromHash,
  getMachineIdentity,
};
