import fs from 'fs-extra';
import path from 'path';
import yauzl from 'yauzl';
import {ipcMain, app} from 'electron';

const getInstallDir = () => {
    if (app.isPackaged) {
        return path.dirname(app.getPath('exe'));
    }
    return path.resolve(__dirname, '..', '..', '..');
};

const boardPacksDir = () => path.join(getInstallDir(), 'board-packs');
const packagesDir  = () => path.join(getInstallDir(), 'tools', 'Arduino', 'packages');

const readManifest = () => {
    const mf = path.join(boardPacksDir(), 'manifest.json');
    if (!fs.existsSync(mf)) return {};
    try { return JSON.parse(fs.readFileSync(mf, 'utf-8')); } catch (_) { return {}; }
};

/*
 * \\?\ long-path prefix — bypasses Windows MAX_PATH (260 chars) for all boards.
 *
 * Boards like ESP32 and RP2040 contain deeply nested paths in their zip files
 * (e.g. esp32\tools\esp32-arduino-libs\idf-release_v5.3-...\connectedhomeip\...)
 * that exceed 260 chars once combined with the destination prefix.  Every path
 * that touches the packages directory is run through this helper so the limit is
 * bypassed uniformly for arduino, esp32, esp8266, rp2040, Maixduino and SparkFun.
 *
 * path.join() preserves the \\?\ prefix when concatenating child segments, so
 * a longPath root propagates correctly through recursive directory walks.
 */
const longPath = p => {
    if (process.platform !== 'win32') return p;
    const abs = path.resolve(p);
    if (abs.startsWith('\\\\?\\')) return abs;
    return `\\\\?\\${abs}`;
};

const isInstalled = pkgId =>
    fs.existsSync(longPath(path.join(packagesDir(), pkgId)));

/* Walk the directory tree using longPath so reads succeed on deep packages */
const getDirSizeBytes = dir => {
    let total = 0;
    const lp = longPath(dir);
    try {
        const items = fs.readdirSync(lp, {withFileTypes: true});
        for (const item of items) {
            /* path.join preserves the \\?\ prefix, so children are also long-path */
            const full = path.join(lp, item.name);
            total += item.isDirectory() ? getDirSizeBytes(full) : (fs.statSync(full).size || 0);
        }
    } catch (_) { /* ignore unreadable entries */ }
    return total;
};

/* Remove a package directory, using longPath so deeply nested files are reachable */
const removePackageDir = async pkgId => {
    const pkgDir = longPath(path.join(packagesDir(), pkgId));
    if (fs.existsSync(pkgDir)) {
        await fs.remove(pkgDir);
    }
};

/* ── Active installations: pkgId → { cancel } ────────────────────────────── */
const _active = new Map();

/* ── Extract a zip with yauzl, using longPath for every destination ──────── */
const extractZip = (zipPath, destDir, {onProgress, isCancelled}) =>
    new Promise((resolve, reject) => {
        yauzl.open(zipPath, {lazyEntries: true, autoClose: true}, (openErr, zipfile) => {
            if (openErr) return reject(openErr);

            const total = zipfile.entryCount;
            let done = 0;

            zipfile.readEntry();

            zipfile.on('entry', entry => {
                if (isCancelled()) {
                    zipfile.close();
                    return reject(new Error('Installation cancelled.'));
                }

                /* Zip entries always use forward slashes; normalise to OS separator */
                const relPath = entry.fileName.replace(/\//g, path.sep);
                /* Apply longPath so every board's deep paths are reachable */
                const destFull = longPath(path.join(destDir, relPath));

                if (/[/\\]$/.test(entry.fileName)) {
                    /* Directory entry */
                    fs.ensureDir(destFull)
                        .then(() => { done++; onProgress(done, total); zipfile.readEntry(); })
                        .catch(reject);
                } else {
                    /* File entry — ensure parent directory exists first */
                    fs.ensureDir(path.dirname(destFull))
                        .then(() => new Promise((res, rej) => {
                            zipfile.openReadStream(entry, (streamErr, readStream) => {
                                if (streamErr) return rej(streamErr);
                                const out = fs.createWriteStream(destFull);
                                readStream.on('error', rej);
                                out.on('error', rej);
                                out.on('finish', res);
                                readStream.pipe(out);
                            });
                        }))
                        .then(() => { done++; onProgress(done, total); zipfile.readEntry(); })
                        .catch(reject);
                }
            });

            zipfile.on('end', () => resolve());
            zipfile.on('error', reject);
        });
    });

/* ── IPC: board-manager:list ─────────────────────────────────────────────── */
ipcMain.handle('board-manager:list', () => {
    const manifest = readManifest();
    return Object.entries(manifest).map(([pkgId, info]) => ({
        pkgId,
        name:           info.name,
        description:    info.description,
        deviceIds:      info.deviceIds || [],
        rawBytes:       info.rawBytes || 0,
        zipBytes:       info.zipBytes || 0,
        zipFile:        info.zipFile,
        installed:      isInstalled(pkgId),
        installing:     _active.has(pkgId),
        installedBytes: isInstalled(pkgId)
            ? getDirSizeBytes(path.join(packagesDir(), pkgId)) : 0
    }));
});

/* ── IPC: board-manager:install ──────────────────────────────────────────── */
ipcMain.handle('board-manager:install', async (event, pkgId) => {
    const manifest = readManifest();
    const info = manifest[pkgId];
    if (!info) throw new Error(`Unknown board package: ${pkgId}`);

    if (_active.has(pkgId)) return {pkgId, installing: true};

    const zipPath = path.join(boardPacksDir(), info.zipFile || `${pkgId}.zip`);
    if (!fs.existsSync(zipPath)) throw new Error(`Board pack not found: ${zipPath}`);

    /* Check free disk space before starting — rawBytes is the extracted size */
    if (info.rawBytes && process.platform === 'win32') {
        try {
            const driveLetter = path.parse(getInstallDir()).root.replace(/\\/g, '').replace(':', '');
            const {execFile} = await import('child_process');
            const {promisify} = await import('util');
            const execFileAsync = promisify(execFile);
            const {stdout} = await execFileAsync('powershell.exe', [
                '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
                '-Command',
                `(Get-PSDrive ${driveLetter}).Free`
            ], {timeout: 5000});
            const freeBytes = parseInt(stdout.trim(), 10);
            if (!isNaN(freeBytes) && freeBytes < info.rawBytes * 1.05) {
                const neededMB = Math.ceil(info.rawBytes / 1024 / 1024);
                const freeMB  = Math.floor(freeBytes     / 1024 / 1024);
                throw new Error(
                    `Not enough disk space. Need ~${neededMB} MB but ` +
                    `only ${freeMB} MB is free on drive ${driveLetter}:`
                );
            }
        } catch (spaceErr) {
            if (spaceErr.message.startsWith('Not enough disk space')) throw spaceErr;
            /* PowerShell unavailable or timed out — proceed anyway */
        }
    }

    const destDir = packagesDir();
    await fs.ensureDir(destDir);

    /* Verify write access early — catches Program Files permission issues */
    const testFile = path.join(destDir, `.write-test-${pkgId}`);
    try {
        await fs.writeFile(testFile, '');
        await fs.remove(testFile);
    } catch (_) {
        throw new Error(
            `Cannot write to the installation folder (${destDir}). ` +
            `Try running the app as administrator.`
        );
    }

    let cancelled = false;
    _active.set(pkgId, {cancel: () => { cancelled = true; }});

    const send = payload => {
        if (!event.sender.isDestroyed()) {
            event.sender.send('board-manager:progress', payload);
        }
    };

    try {
        await extractZip(zipPath, destDir, {
            isCancelled: () => cancelled,
            onProgress: (done, total) => {
                const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
                send({pkgId, percent: pct});
            }
        });
        _active.delete(pkgId);
        send({pkgId, percent: 100, done: true});
        return {pkgId, installed: true};
    } catch (err) {
        _active.delete(pkgId);
        if (cancelled) {
            await removePackageDir(pkgId);
            send({pkgId, percent: 0, error: 'Installation cancelled.'});
            throw new Error('Installation cancelled.');
        }
        send({pkgId, percent: 0, error: err.message});
        throw new Error(`Extraction failed: ${err.message}`);
    }
});

/* ── IPC: board-manager:cancel ───────────────────────────────────────────── */
ipcMain.handle('board-manager:cancel', async (event, pkgId) => {
    const inst = _active.get(pkgId);
    if (inst) inst.cancel();
    return {pkgId, cancelled: true};
});

/* ── IPC: board-manager:remove ───────────────────────────────────────────── */
ipcMain.handle('board-manager:remove', async (event, pkgId) => {
    await removePackageDir(pkgId);
    return {pkgId, installed: false};
});

/* ── IPC: board-manager:is-installed ─────────────────────────────────────── */
ipcMain.handle('board-manager:is-installed', (event, pkgId) => isInstalled(pkgId));
