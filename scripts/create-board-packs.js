#!/usr/bin/env node
/**
 * Creates compressed ZIP archives for each Arduino board package.
 * Run this before `npm run build:dist` so board-packs/ is ready for packaging.
 *
 * Usage: node scripts/create-board-packs.js
 */

const {execSync, spawnSync} = require('child_process');
const fs = require('fs');
const path = require('path');

/* Locate 7-Zip — required for board packs > 2 GB (PowerShell Compress-Archive limit) */
function find7zip () {
    const candidates = [
        'C:\\Program Files\\7-Zip\\7z.exe',
        'C:\\Program Files (x86)\\7-Zip\\7z.exe'
    ];
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    try {
        const r = spawnSync('where', ['7z'], {encoding: 'utf8'});
        if (r.status === 0 && r.stdout.trim()) return r.stdout.trim().split('\n')[0].trim();
    } catch (_) { /* not found */ }
    return null;
}
const SEVEN_ZIP = find7zip();

const PACKAGES_DIR = path.resolve(__dirname, '..', 'tools', 'Arduino', 'packages');
const BOARD_PACKS_DIR = path.resolve(__dirname, '..', 'board-packs');

/* Board pack metadata — maps package folder name → display info + device IDs */
const BOARD_PACKS = {
    arduino: {
        name: 'Arduino boards',
        description: 'Arduino Uno, Nano, Leonardo, Mega, UNO R4 Minima, UNO R4 WiFi',
        deviceIds: [
            'arduinoUno', 'arduinoNano', 'arduinoLeonardo',
            'arduinoMega2560', 'arduinoUnoR4Minima', 'arduinoUnoR4Wifi'
        ]
    },
    esp32: {
        name: 'ESP32 boards',
        description: 'ESP32, ESP32-S3 and all ESP32 variants',
        deviceIds: ['arduinoEsp32', 'arduinoEsp32S3']
    },
    esp8266: {
        name: 'ESP8266 boards',
        description: 'NodeMCU, ESP8266-based boards',
        deviceIds: ['arduinoEsp8266NodeMCU']
    },
    rp2040: {
        name: 'Raspberry Pi Pico boards',
        description: 'Raspberry Pi Pico, Pico W, Pico 2, Pico 2W',
        deviceIds: [
            'arduinoRaspberryPiPico', 'arduinoRaspberryPiPicoW',
            'arduinoRaspberryPiPico2', 'arduinoRaspberryPiPico2W'
        ]
    },
    Maixduino: {
        name: 'Maixduino boards',
        description: 'Sipeed MaixDock, Maixduino (K210 RISC-V)',
        deviceIds: ['arduinoK210MaixDock', 'arduinoK210Maixduino']
    },
    SparkFun: {
        name: 'SparkFun boards',
        description: 'SparkFun AVR variants',
        deviceIds: []
    }
};

function getDirSizeBytes (dir) {
    let total = 0;
    let items;
    try { items = fs.readdirSync(dir, {withFileTypes: true}); } catch (_) { return 0; }
    for (const item of items) {
        const full = path.join(dir, item.name);
        total += item.isDirectory() ? getDirSizeBytes(full) : (fs.statSync(full).size || 0);
    }
    return total;
}

function mb (bytes) { return `${Math.round(bytes / 1024 / 1024)} MB`; }

if (!fs.existsSync(BOARD_PACKS_DIR)) {
    fs.mkdirSync(BOARD_PACKS_DIR, {recursive: true});
}

console.log(`Using compressor: ${SEVEN_ZIP ? `7-Zip (${SEVEN_ZIP})` : 'PowerShell Compress-Archive'}`);
if (!SEVEN_ZIP) console.log('Tip: install 7-Zip to handle board packs > 2 GB.\n');

const manifest = {};
let totalRaw = 0, totalZip = 0;

for (const [pkgId, info] of Object.entries(BOARD_PACKS)) {
    const pkgDir = path.join(PACKAGES_DIR, pkgId);
    if (!fs.existsSync(pkgDir)) {
        console.log(`[skip] ${pkgId} — not found in tools/Arduino/packages/`);
        continue;
    }

    const zipPath = path.join(BOARD_PACKS_DIR, `${pkgId}.zip`);
    const rawBytes = getDirSizeBytes(pkgDir);
    totalRaw += rawBytes;

    process.stdout.write(`[zip]  ${pkgId} (${mb(rawBytes)}) → ${pkgId}.zip ... `);

    /* Remove old archive so the compressor doesn't append to it */
    if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);

    /* Use 7-Zip when available (no 2 GB limit, faster).
       Fall back to PowerShell Compress-Archive for packs that fit within its 2 GB limit. */
    let cmd;
    if (SEVEN_ZIP) {
        /* 7z a -tzip -mx=5 out.zip folderPath — zips folder WITH its name as root */
        cmd = `"${SEVEN_ZIP}" a -tzip -mx=5 "${zipPath}" "${pkgDir}"`;
    } else {
        if (rawBytes > 2 * 1024 * 1024 * 1024) {
            console.error(`\n[error] ${pkgId} is ${mb(rawBytes)} — too large for PowerShell Compress-Archive (2 GB limit).`);
            console.error('        Install 7-Zip from https://www.7-zip.org/ and re-run.\n');
            process.exit(1);
        }
        /* PowerShell Compress-Archive: -Path 'dir' zips the folder WITH its name as root.
           Extracting to packages/ recreates packages/<pkgId>/  */
        cmd = `powershell -NoProfile -NonInteractive -Command ` +
            `"Compress-Archive -Path '${pkgDir}' -DestinationPath '${zipPath}' -CompressionLevel Optimal"`;
    }

    try {
        execSync(cmd, {stdio: 'pipe'});
    } catch (err) {
        console.error(`\nFailed: ${err.message}`);
        process.exit(1);
    }

    if (!fs.existsSync(zipPath)) {
        console.error(`\n[error] ${pkgId}.zip was not created — compressor may have hit a size or memory limit.`);
        if (!SEVEN_ZIP) console.error('        Install 7-Zip from https://www.7-zip.org/ and re-run.');
        process.exit(1);
    }

    const zipBytes = fs.statSync(zipPath).size;
    totalZip += zipBytes;
    const ratio = Math.round((1 - zipBytes / rawBytes) * 100);
    console.log(`done (${mb(zipBytes)}, ${ratio}% smaller)`);

    manifest[pkgId] = {
        ...info,
        rawBytes,
        zipBytes,
        zipFile: `${pkgId}.zip`
    };
}

/* Write manifest so the app knows what packages exist */
fs.writeFileSync(
    path.join(BOARD_PACKS_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2)
);

console.log(`\nDone! ${Object.keys(manifest).length} board packs created.`);
console.log(`  Raw total : ${mb(totalRaw)}`);
console.log(`  Zip total : ${mb(totalZip)}`);
console.log(`  Saved     : ${mb(totalRaw - totalZip)}`);
console.log(`\nboard-packs/ is ready for packaging.`);
