import fs from 'fs-extra';
import path from 'path';
import os from 'os';
import {spawn} from 'child_process';
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

/* Escape a string for safe embedding inside a PowerShell single-quoted literal. */
const psSingleQuote = s => `'${String(s).replace(/'/g, "''")}'`;

/* ── Long-path-safe, ELEVATED extraction ─────────────────────────────────────
 * Used when the packages dir isn't writable by the current (unelevated) process —
 * e.g. an all-users install under C:\Program Files. The bundled NSIS installer
 * extracts boards into that same folder while elevated, so the "install a board
 * later" flow needs the same elevation. We relaunch the extraction with ONE UAC
 * prompt, mirroring extractZip()'s logic in PowerShell/.NET: each entry is copied
 * through a \\?\ long path so ESP32/RP2040 deep paths (>260 chars) succeed —
 * PowerShell's Expand-Archive cannot handle them, which is why we don't use it.
 */
const elevatedExtract = (zipPath, destDir, pkgId, rawBytes, {send}) =>
    new Promise((resolve, reject) => {
        // Self-contained extractor script (paths baked in to avoid arg-quoting issues).
        const script = [
            `$ErrorActionPreference = 'Stop'`,
            `$Zip  = ${psSingleQuote(zipPath)}`,
            `$Dest = ${psSingleQuote(destDir)}`,
            `Add-Type -AssemblyName System.IO.Compression.FileSystem`,
            `$archive = [System.IO.Compression.ZipFile]::OpenRead($Zip)`,
            `try {`,
            `  foreach ($entry in $archive.Entries) {`,
            `    $rel  = $entry.FullName -replace '/', '\\'`,
            `    $full = [System.IO.Path]::GetFullPath((Join-Path $Dest $rel))`,
            `    $lp   = '\\\\?\\' + $full`,
            `    if ($entry.FullName.EndsWith('/')) {`,
            `      [System.IO.Directory]::CreateDirectory($lp) | Out-Null`,
            `    } else {`,
            `      [System.IO.Directory]::CreateDirectory([System.IO.Path]::GetDirectoryName($lp)) | Out-Null`,
            `      $in = $entry.Open(); $out = [System.IO.File]::Create($lp)`,
            `      try { $in.CopyTo($out) } finally { $out.Dispose(); $in.Dispose() }`,
            `    }`,
            `  }`,
            `} finally { $archive.Dispose() }`
        ].join('\r\n');

        const ps1 = path.join(os.tmpdir(), `rc-board-${pkgId}-${Date.now()}.ps1`);
        try {
            fs.writeFileSync(ps1, script, 'utf8');
        } catch (e) { return reject(e); }

        // Outer (unelevated) PowerShell elevates the extractor and WAITS for it, then
        // surfaces its exit code. A thrown Start-Process (UAC declined) maps to 1223.
        const outer =
            `try { $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden ` +
            `-ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',${psSingleQuote(ps1)}; ` +
            `exit $p.ExitCode } catch { exit 1223 }`;

        const child = spawn('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', outer],
            {windowsHide: true});

        const pkgDir = path.join(destDir, pkgId);
        const poll = setInterval(() => {
            if (rawBytes > 0) {
                const size = getDirSizeBytes(pkgDir);
                send({pkgId, percent: Math.min(99, Math.round((size / rawBytes) * 100))});
            }
        }, 600);

        let stderr = '';
        child.stderr.on('data', d => { stderr += d.toString(); });

        const cleanup = () => { clearInterval(poll); fs.remove(ps1).catch(() => {}); };

        child.on('error', err => { cleanup(); reject(err); });
        child.on('close', code => {
            cleanup();
            if (code === 0 && isInstalled(pkgId)) return resolve();
            // Failed/declined — remove any partial extraction so a retry starts clean.
            removePackageDir(pkgId).catch(() => {});
            if (code === 1223) {
                return reject(new Error(
                    'Administrator permission is required to install this board. ' +
                    'Please choose "Yes" on the Windows prompt and try again.'));
            }
            reject(new Error(stderr.trim() || 'Board installation failed.'));
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

    /* Probe write access. An all-users install (C:\Program Files) is read-only for the
     * unelevated app — in that case we extract via a one-time UAC elevation instead of
     * failing, matching how the bundled installer extracts boards while elevated. */
    let writable = true;
    const testFile = path.join(destDir, `.write-test-${pkgId}`);
    try {
        await fs.writeFile(testFile, '');
        await fs.remove(testFile);
    } catch (_) {
        writable = false;
    }

    let cancelled = false;
    _active.set(pkgId, {cancel: () => { cancelled = true; }});

    const send = payload => {
        if (!event.sender.isDestroyed()) {
            event.sender.send('board-manager:progress', payload);
        }
    };

    try {
        if (writable) {
            await extractZip(zipPath, destDir, {
                isCancelled: () => cancelled,
                onProgress: (done, total) => {
                    const pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : 0;
                    send({pkgId, percent: pct});
                }
            });
        } else {
            /* Program Files / all-users install — extract with a single elevation prompt.
             * (Cancel isn't supported once the elevated process is running.) */
            send({pkgId, percent: 0});
            await elevatedExtract(zipPath, destDir, pkgId, info.rawBytes || 0, {send});
        }
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
        throw new Error(err.message);
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
