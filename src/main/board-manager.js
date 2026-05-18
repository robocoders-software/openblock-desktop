import fs from 'fs-extra';
import path from 'path';
import {execFile} from 'child_process';
import {promisify} from 'util';
import {ipcMain, app} from 'electron';

const execFileAsync = promisify(execFile);

const getInstallDir = () => {
    if (app.isPackaged) {
        return path.dirname(app.getPath('exe'));
    }
    /* In dev, fall back to the project root so we can still test */
    return path.resolve(__dirname, '..', '..', '..');
};

const boardPacksDir = () => path.join(getInstallDir(), 'board-packs');
const packagesDir = () => path.join(getInstallDir(), 'tools', 'Arduino', 'packages');

const readManifest = () => {
    const mf = path.join(boardPacksDir(), 'manifest.json');
    if (!fs.existsSync(mf)) return {};
    try { return JSON.parse(fs.readFileSync(mf, 'utf-8')); } catch (_) { return {}; }
};

const isInstalled = pkgId => fs.existsSync(path.join(packagesDir(), pkgId));

const getDirSizeBytes = dir => {
    let total = 0;
    try {
        const items = fs.readdirSync(dir, {withFileTypes: true});
        for (const item of items) {
            const full = path.join(dir, item.name);
            total += item.isDirectory() ? getDirSizeBytes(full) : (fs.statSync(full).size || 0);
        }
    } catch (_) { /* ignore */ }
    return total;
};

/* ── IPC: board-manager:list ─────────────────────────────────────────────── */
ipcMain.handle('board-manager:list', () => {
    const manifest = readManifest();
    return Object.entries(manifest).map(([pkgId, info]) => ({
        pkgId,
        name:        info.name,
        description: info.description,
        deviceIds:   info.deviceIds || [],
        rawBytes:    info.rawBytes || 0,
        zipBytes:    info.zipBytes || 0,
        zipFile:     info.zipFile,
        installed:   isInstalled(pkgId),
        installedBytes: isInstalled(pkgId) ? getDirSizeBytes(path.join(packagesDir(), pkgId)) : 0
    }));
});

/* ── IPC: board-manager:install ──────────────────────────────────────────── */
ipcMain.handle('board-manager:install', async (event, pkgId) => {
    const manifest = readManifest();
    const info = manifest[pkgId];
    if (!info) throw new Error(`Unknown board package: ${pkgId}`);

    const zipPath = path.join(boardPacksDir(), info.zipFile || `${pkgId}.zip`);
    if (!fs.existsSync(zipPath)) throw new Error(`Board pack not found: ${zipPath}`);

    const destDir = packagesDir();
    await fs.ensureDir(destDir);

    /* Use PowerShell Expand-Archive — available on all supported Windows versions */
    const ps = `Expand-Archive -Path '${zipPath}' -DestinationPath '${destDir}' -Force`;

    try {
        await execFileAsync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
            '-Command', ps
        ]);
    } catch (err) {
        throw new Error(`Extraction failed: ${err.message}`);
    }

    return {pkgId, installed: true};
});

/* ── IPC: board-manager:remove ───────────────────────────────────────────── */
ipcMain.handle('board-manager:remove', async (event, pkgId) => {
    const pkgDir = path.join(packagesDir(), pkgId);
    if (!fs.existsSync(pkgDir)) return {pkgId, installed: false};
    await fs.remove(pkgDir);
    return {pkgId, installed: false};
});

/* ── IPC: board-manager:is-installed ─────────────────────────────────────── */
ipcMain.handle('board-manager:is-installed', (event, pkgId) => isInstalled(pkgId));
