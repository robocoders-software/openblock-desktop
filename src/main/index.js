import * as remote from '@electron/remote/main';
import fs from 'fs-extra';
import path from 'path';
import {URL} from 'url';
import {promisify} from 'util';
import argv from './argv';
import {getFilterForExtension} from './FileFilters';
import telemetry, {attachTelemetryIpcMain} from './OpenblockDesktopTelemetry';
import Updater from './OpenblockDesktopUpdater';
import DesktopLink from './OpenblockDesktopLink.js';
import MacOSMenu from './MacOSMenu';
import log from '../common/log.js';
import {productName, version} from '../../package.json';

import {v4 as uuidv4} from 'uuid';
import ElectronStore from 'electron-store';
import formatMessage from 'format-message';
import locales from 'openblock-l10n/locales/desktop-msgs';

import {
    BrowserWindow,
    Menu,
    app,
    dialog,
    ipcMain,
    protocol,
    shell,
    systemPreferences
} from 'electron';

const storage = new ElectronStore();
let desktopLink;

/* ── ML filesystem root ── */
const mlDir = projectId => path.join(app.getPath('userData'), 'ml-projects', projectId);

/* Last .ob file path the renderer reported opening (for ml-get-loaded-data fallback). */
let _lastOpenedFilePath = null;

/* The currently active project file path — used for silent Save (no dialog). */
let _currentProjectFilePath = null;

/* Recursively collect all file paths within dir, returning paths relative to base. */
const walkDir = async (dir, base) => {
    const results = [];
    let items;
    try { items = await fs.readdir(dir, {withFileTypes: true}); } catch (_) { return results; }
    for (const item of items) {
        const full = path.join(dir, item.name);
        if (item.isDirectory()) {
            results.push(...await walkDir(full, base));
        } else {
            results.push(path.relative(base, full).replace(/\\/g, '/'));
        }
    }
    return results;
};

/* Bundle <projectDir>/** into a JSZip under the 'ml/' prefix. */
const bundleMLDir = async (zip, projectId) => {
    const base  = mlDir(projectId);
    const files = await walkDir(base, base);
    for (const rel of files) {
        const abs = path.join(base, rel);
        const buf = await fs.readFile(abs);
        zip.file(`ml/${rel}`, buf);
    }
};

/* Extract 'ml/*' entries from a JSZip to <projectDir>. Guards against path traversal. */
const extractMLDir = async (zip, projectId) => {
    const dest  = mlDir(projectId);
    const files = Object.keys(zip.files).filter(k => k.startsWith('ml/') && !zip.files[k].dir);
    for (const zipPath of files) {
        const rel = zipPath.slice(3); // strip 'ml/'
        // Reject paths that escape the destination directory (path traversal guard)
        const abs = path.resolve(dest, rel);
        if (!abs.startsWith(path.resolve(dest) + path.sep) && abs !== path.resolve(dest)) {
            log.warn(`[main] Rejected unsafe zip path: ${zipPath}`);
            continue;
        }
        await fs.ensureDir(path.dirname(abs));
        const content = await zip.files[zipPath].async('nodebuffer');
        await fs.writeFile(abs, content);
    }
};

/* In-memory: projectId of the last trained/saved ML project (for will-download injection). */
let _pendingMLProjectId = null;

formatMessage.setup({translations: locales});

// suppress deprecation warning; this will be the default in Electron 9
app.allowRendererProcessReuse = true;

// allow connect to localhost
app.commandLine.appendSwitch('allow-insecure-localhost', 'true');

// enable gpu and ignore gpu blacklist
app.commandLine.appendSwitch('enable-gpu');
app.commandLine.appendSwitch('ignore-gpu-blacklist');

telemetry.appWasOpened();

const defaultSize = {width: 1620, height: 900};

const isDevelopment = process.env.NODE_ENV !== 'production';

const devToolKey = ((process.platform === 'darwin') ?
    { // macOS: command+option+i
        alt: true, // option
        control: false,
        meta: true, // command
        shift: false,
        code: 'KeyI'
    } : { // Windows: control+shift+i
        alt: false,
        control: true,
        meta: false, // Windows key
        shift: true,
        code: 'KeyI'
    }
);

// global window references prevent them from being garbage-collected
const _windows = {};

// enable connecting to Scratch Link even if we DNS / Internet access is not available
// this must happen BEFORE the app ready event!
app.commandLine.appendSwitch('host-resolver-rules', 'MAP device-manager.scratch.mit.edu 127.0.0.1');

const displayPermissionDeniedWarning = (browserWindow, permissionType) => {
    let title;
    let message;
    switch (permissionType) {
    case 'camera':
        title = formatMessage({
            id: 'index.cameraPermissionDeniedTitle',
            default: 'Camera Permission Denied',
            description: 'prompt for camera permission denied'
        });
        message = formatMessage({
            id: 'index.cameraPermissionDeniedMessage',
            default: 'Permission to use the camera has been denied. ' +
                'RoboCoders-studio will not be able to take a photo or use video sensing blocks.',
            description: 'message for camera permission denied'
        });
        break;
    case 'microphone':
        title = formatMessage({
            id: 'index.microphonePermissionDeniedTitle',
            default: 'Microphone Permission Denied',
            description: 'prompt for microphone permission denied'
        });
        message = formatMessage({
            id: 'index.microphonePermissionDeniedMessage',
            default: 'Permission to use the microphone has been denied. ' +
                    'RoboCoders-studio will not be able to record sounds or detect loudness.',
            description: 'message for microphone permission denied'
        });
        break;
    default: // shouldn't ever happen...
        title = formatMessage({
            id: 'index.permissionDeniedTitle',
            default: 'Permission Denied',
            description: 'prompt for permission denied'
        });
        message = formatMessage({
            id: 'index.permissionDeniedMessage',
            default: 'A permission has been denied.',
            description: 'message for permission denied'
        });
    }

    let instructions;
    switch (process.platform) {
    case 'darwin':
        instructions = formatMessage({
            id: 'index.darwinPermissionDeniedInstructions',
            default: 'To change RoboCoders-studio permissions, please check "Security & Privacy" in System Preferences.',
            description: 'prompt for fix darwin permission denied instructions'
        });
        break;
    default:
        instructions = formatMessage({
            id: 'index.permissionDeniedInstructions',
            default: 'To change RoboCoders-studio permissions, please check your system settings and restart RoboCoders-studio.',
            description: 'prompt for fix permission denied instructions'
        });
        break;
    }
    message = `${message}\n\n${instructions}`;

    dialog.showMessageBox(browserWindow, {type: 'warning', title, message});
};

/**
 * Build an absolute URL from a relative one, optionally adding search query parameters.
 * The base of the URL will depend on whether or not the application is running in development mode.
 * @param {string} url - the relative URL, like 'index.html'
 * @param {*} search - the optional "search" parameters (the part of the URL after '?'), like "route=about"
 * @returns {string} - an absolute URL as a string
 */
const makeFullUrl = (url, search = null) => {
    const baseUrl = (isDevelopment ?
        `http://localhost:${process.env.ELECTRON_WEBPACK_WDS_PORT}/` :
        `file://${__dirname}/`
    );
    const fullUrl = new URL(url, baseUrl);
    if (search) {
        fullUrl.search = search; // automatically percent-encodes anything that needs it
    }
    return fullUrl.toString();
};

/**
 * Prompt in a platform-specific way for permission to access the microphone or camera, if Electron supports doing so.
 * Any application-level checks, such as whether or not a particular frame or document should be allowed to ask,
 * should be done before calling this function.
 * This function may return a Promise!
 *
 * @param {string} mediaType - one of Electron's media types, like 'microphone' or 'camera'
 * @returns {boolean|Promise.<boolean>} - true if permission granted, false otherwise.
 */
const askForMediaAccess = mediaType => {
    if (systemPreferences.askForMediaAccess) {
        // Electron currently only implements this on macOS
        // This returns a Promise
        return systemPreferences.askForMediaAccess(mediaType);
    }
    // For other platforms we can't reasonably do anything other than assume we have access.
    return true;
};

const handlePermissionRequest = async (webContents, permission, callback, details) => {
    if (webContents !== _windows.main.webContents) {
        // deny: request came from somewhere other than the main window's web contents
        return callback(false);
    }
    if (!details.isMainFrame) {
        // deny: request came from a subframe of the main window, not the main frame
        return callback(false);
    }
    if (permission !== 'media') {
        // deny: request is for some other kind of access like notifications or pointerLock
        return callback(false);
    }
    const requiredBase = makeFullUrl('');
    if (details.requestingUrl.indexOf(requiredBase) !== 0) {
        // deny: request came from a URL outside of our "sandbox"
        return callback(false);
    }
    let askForMicrophone = false;
    let askForCamera = false;
    for (const mediaType of details.mediaTypes) {
        switch (mediaType) {
        case 'audio':
            askForMicrophone = true;
            break;
        case 'video':
            askForCamera = true;
            break;
        default:
            // deny: unhandled media type
            return callback(false);
        }
    }
    const parentWindow = _windows.main; // if we ever allow media in non-main windows we'll also need to change this
    if (askForMicrophone) {
        const microphoneResult = await askForMediaAccess('microphone');
        if (!microphoneResult) {
            displayPermissionDeniedWarning(parentWindow, 'microphone');
            return callback(false);
        }
    }
    if (askForCamera) {
        const cameraResult = await askForMediaAccess('camera');
        if (!cameraResult) {
            displayPermissionDeniedWarning(parentWindow, 'camera');
            return callback(false);
        }
    }
    return callback(true);
};

const createWindow = ({search = null, url = 'index.html', ...browserWindowOptions}) => {
    const window = new BrowserWindow({
        useContentSize: true,
        show: false,
        webPreferences: {
            contextIsolation: false,
            nodeIntegration: true,
            webSecurity: false
        },
        ...browserWindowOptions
    });
    const webContents = window.webContents;

    webContents.session.setPermissionRequestHandler(handlePermissionRequest);

    webContents.on('before-input-event', (event, input) => {
        if (input.code === devToolKey.code &&
            input.alt === devToolKey.alt &&
            input.control === devToolKey.control &&
            input.meta === devToolKey.meta &&
            input.shift === devToolKey.shift &&
            input.type === 'keyDown' &&
            !input.isAutoRepeat &&
            !input.isComposing) {
            event.preventDefault();
            webContents.openDevTools({mode: 'detach', activate: true});
        }
    });

    webContents.on('new-window', (event, newWindowUrl) => {
        shell.openExternal(newWindowUrl);
        event.preventDefault();
    });

    const fullUrl = makeFullUrl(url, search);
    window.loadURL(fullUrl);
    window.once('ready-to-show', () => {
        webContents.send('ready-to-show');
    });

    return window;
};

const createAboutWindow = () => {
    const window = createWindow({
        width: 400,
        height: 400,
        parent: _windows.main,
        search: 'route=about',
        title: `About ${productName}`
    });
    return window;
};

const createLicenseWindow = () => {
    const window = createWindow({
        width: _windows.main.width * 0.8,
        height: _windows.main.height * 0.8,
        parent: _windows.main,
        search: 'route=license',
        title: `${productName} License`
    });
    return window;
};

const createPrivacyWindow = () => {
    const window = createWindow({
        width: _windows.main.width * 0.8,
        height: _windows.main.height * 0.8,
        parent: _windows.main,
        search: 'route=privacy',
        title: `${productName} Privacy Policy`
    });
    return window;
};

const createLoadingWindow = () => {
    const window = createWindow({
        width: 800,
        height: 150,
        frame: false,
        resizable: false,
        transparent: true,
        hasShadow: false,
        search: 'route=loading',
        title: `Loading ${productName} ${version}`
    });

    window.once('ready-to-show', () => {
        window.show();
    });

    return window;
};

const getIsProjectSave = downloadItem => {
    switch (downloadItem.getMimeType()) {
    case 'application/x.openblock.ob':
        return true;
    }
    return false;
};

const createMainWindow = () => {
    const window = createWindow({
        width: defaultSize.width,
        height: defaultSize.height,
        title: `${productName} ${version}` // something like "Scratch 3.14"
    });
    const webContents = window.webContents;

    const update = new Updater(webContents, desktopLink.resourceServer);
    remote.initialize();
    remote.enable(webContents);

    webContents.session.on('will-download', (willDownloadEvent, downloadItem) => {
        const isProjectSave = getIsProjectSave(downloadItem);
        const itemPath = downloadItem.getFilename();
        const baseName = path.basename(itemPath);
        const extName = path.extname(baseName);
        const options = {
            defaultPath: baseName
        };
        if (extName) {
            const extNameNoDot = extName.replace(/^\./, '');
            options.filters = [getFilterForExtension(extNameNoDot)];
        }
        const userChosenPath = dialog.showSaveDialogSync(window, options);
        // this will be falsy if the user canceled the save
        if (userChosenPath) {
            const userBaseName = path.basename(userChosenPath);
            const tempPath = path.join(app.getPath('temp'), userBaseName);

            // WARNING: `setSavePath` on this item is only valid during the `will-download` event. Calling the async
            // version of `showSaveDialog` means the event will finish before we get here, so `setSavePath` will be
            // ignored. For that reason we need to call `showSaveDialogSync` above.
            downloadItem.setSavePath(tempPath);

            downloadItem.on('done', async (doneEvent, doneState) => {
                try {
                    if (doneState !== 'completed') {
                        // The download was canceled or interrupted. Cancel the telemetry event and delete the file.
                        throw new Error(`save ${doneState}`); // "save cancelled" or "save interrupted"
                    }
                    /* Inject ML filesystem directory into the .ob ZIP before final move.
                       If bundling fails, abort the save so the user gets a complete file or nothing. */
                    if (isProjectSave && _pendingMLProjectId) {
                        try {
                            const JSZip      = require('jszip');
                            const fileBuffer = await fs.readFile(tempPath);
                            const zip        = await JSZip.loadAsync(fileBuffer);
                            await bundleMLDir(zip, _pendingMLProjectId);
                            const newBuffer  = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
                            await fs.writeFile(tempPath, newBuffer);
                            _pendingMLProjectId = null; // clear only on success
                        } catch (mlErr) {
                            log.error('[main] ML FS injection failed, aborting save:', mlErr.message);
                            _pendingMLProjectId = null; // clear to prevent stale state on next save
                            throw new Error(`ML data could not be bundled: ${mlErr.message}`);
                        }
                    }
                    await fs.move(tempPath, userChosenPath, {overwrite: true});
                    if (isProjectSave) {
                        /* Track this path so Ctrl+S can overwrite without a dialog */
                        _currentProjectFilePath = userChosenPath;
                        const newProjectTitle = path.basename(userChosenPath, extName);
                        webContents.send('setTitleFromSave', {title: newProjectTitle});

                        // "setTitleFromSave" will set the project title but GUI has already reported the telemetry
                        // event using the old title. This call lets the telemetry client know that the save was
                        // actually completed and the event should be committed to the event queue with this new title.
                        telemetry.projectSaveCompleted(newProjectTitle);
                    }
                } catch (e) {
                    if (isProjectSave) {
                        telemetry.projectSaveCanceled();
                    }
                    // don't clean up until after the message box to allow troubleshooting / recovery
                    await dialog.showMessageBox(window, {
                        type: 'error',
                        title: formatMessage({
                            id: 'index.saveFailedTitle',
                            default: 'Failed to save project',
                            description: 'Title for save failed'
                        }),
                        message: `${formatMessage({
                            id: 'index.saveFailed',
                            default: 'Save failed:',
                            description: 'prompt for save failed'
                        })}\n${userChosenPath}`,
                        detail: e.message
                    });
                    fs.exists(tempPath).then(exists => {
                        if (exists) {
                            fs.unlink(tempPath);
                        }
                    });
                }
            });
        } else {
            downloadItem.cancel();
            if (isProjectSave) {
                telemetry.projectSaveCanceled();
            }
        }
    });

    webContents.on('will-prevent-unload', ev => {
        const choice = dialog.showMessageBoxSync(window, {
            title: productName,
            type: 'question',
            message: formatMessage({
                id: 'index.questionLeave',
                default: 'Leave RoboCoders-studio?',
                description: 'prompt for leave RoboCoders-studio'
            }),
            detail: formatMessage({
                id: 'index.questionLeaveDetail',
                default: 'Any unsaved changes will be lost.',
                description: 'detail prompt for leave RoboCoders-studio'
            }),
            buttons: [
                formatMessage({
                    id: 'index.stay',
                    default: 'Stay',
                    description: 'Label for stay'
                }), formatMessage({
                    id: 'index.leave',
                    default: 'Leave',
                    description: 'Label for leave'
                })
            ],
            cancelId: 0, // closing the dialog means "stay"
            defaultId: 0 // pressing enter or space without explicitly selecting something means "stay"
        });
        const shouldQuit = (choice === 1);
        if (shouldQuit) {
            ev.preventDefault();
        }
    });

    /* Update window title to show unsaved-changes indicator (• prefix when dirty) */
    ipcMain.on('project-dirty-changed', (event, {dirty, title}) => {
        if (window) {
            const base = title || productName;
            window.setTitle(dirty ? `• ${base}` : base);
        }
    });

    ipcMain.on('loading-completed', () => {
        if (!storage.has('userId')) {
            storage.set('userId', uuidv4());
        }
        const userId = storage.get('userId');
        webContents.send('setUserId', userId);

        webContents.send('setPlatform', process.platform);

        // If the app was launched by opening a project file, tell the renderer its title
        // so the menu-bar title input and window title stay in sync from the first load.
        if (_currentProjectFilePath) {
            const title = path.basename(_currentProjectFilePath, path.extname(_currentProjectFilePath));
            webContents.send('setTitleFromOpen', {title});
        }

        update.checkUpdateAtStartup();
    });

    ipcMain.on('requestCheckUpdate', () => {
        update.requestCheckUpdate(_windows.main);
    });

    ipcMain.on('requestUpdate', () => {
        update.requestUpdate()
            .then(() => {
                setTimeout(() => {
                    console.log(`INFO: App will restart after 3 seconds`);
                    app.relaunch();
                    app.exit();
                }, 1000 * 3);
            })
            .catch(err => {
                console.error(`ERR!: update failed: ${err}`);
            });
    });

    ipcMain.on('abortUpdate', () => {
        update.abortUpdate();
    });

    return window;
};

if (process.platform === 'darwin') {
    const osxMenu = Menu.buildFromTemplate(MacOSMenu(app));
    Menu.setApplicationMenu(osxMenu);
} else {
    // disable menu for other platforms
    Menu.setApplicationMenu(null);
}

// quit application when all windows are closed
app.on('window-all-closed', () => {
    app.quit();
});

app.on('will-quit', () => {
    telemetry.appWillClose();
});

app.on('activate', () => {
    if (_windows.main === null) {
        createMainWindow();
    }
});

// work around https://github.com/MarshallOfSound/electron-devtools-installer/issues/122
// which seems to be a result of https://github.com/electron/electron/issues/19468
if (process.platform === 'win32') {
    const appUserDataPath = app.getPath('userData');
    const devToolsExtensionsPath = path.join(appUserDataPath, 'DevTools Extensions');
    try {
        fs.unlinkSync(devToolsExtensionsPath);
    } catch (_) {
        // don't complain if the file doesn't exist
    }
}

// Register custom protocol so TF.js can load local model files without an HTTP server.
// Must be called before app is ready.
protocol.registerSchemesAsPrivileged([{
    scheme: 'robocoders-resource',
    privileges: {standard: true, secure: true, supportFetchAPI: true, corsEnabled: true}
}]);

// create main BrowserWindow when electron is ready
app.on('ready', () => {
    desktopLink = new DesktopLink();

    // Serve external-resources/* via robocoders-resource:// — no HTTP server needed.
    // Works offline, no port conflicts, files read directly from disk.
    // Strip scheme manually: standard schemes parse "models" as hostname, dropping it from pathname.
    protocol.registerFileProtocol('robocoders-resource', (request, callback) => {
        const relative = request.url.replace(/^robocoders-resource:\/\//, '');
        const filePath = path.join(desktopLink.appPath, 'external-resources', relative);
        callback({path: filePath});
    });

    // Read any file from external-resources/ by relative path.
    ipcMain.handle('read-external-resource', async (event, relativePath) => {
        try {
            const fullPath = path.join(desktopLink.appPath, 'external-resources', relativePath);
            return await fs.readFile(fullPath);
        } catch (e) {
            log.error(`[main] read-external-resource failed for "${relativePath}":`, e.message);
            return null;
        }
    });

    // Health-check the resource server and restart it if it has crashed.
    // Called by ml-engine.js before loading the speech-commands model.
    ipcMain.handle('ensure-resource-server', async () => {
        await new Promise((resolve, reject) => {
            const req = require('http').get('http://localhost:20112/', res => {
                res.destroy();
                resolve();
            });
            req.on('error', reject);
            req.setTimeout(1500, () => { req.destroy(); reject(new Error('timeout')); });
        }).catch(async () => {
            log.warn('[main] Resource server not responding — restarting…');
            await desktopLink.start();
        });
    });

    attachTelemetryIpcMain();

    /* ══════════════════════════════════════════════════════════════
       ML filesystem IPC handlers
       All ML project data lives in:
         <userData>/ml-projects/<projectId>/
       ══════════════════════════════════════════════════════════════ */

    /* Write a file (text string or binary Buffer/Uint8Array) into the ML project directory */
    ipcMain.handle('ml-write-file', async (event, projectId, relativePath, data) => {
        const filePath = path.join(mlDir(projectId), relativePath);
        await fs.ensureDir(path.dirname(filePath));
        const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
        await fs.writeFile(filePath, buf);
    });

    /* Read a file from the ML project directory; returns Buffer or null */
    ipcMain.handle('ml-read-file', async (event, projectId, relativePath) => {
        try { return await fs.readFile(path.join(mlDir(projectId), relativePath)); }
        catch (_) { return null; }
    });

    /* List filenames (not full paths) in a subdirectory of the ML project directory */
    ipcMain.handle('ml-list-files', async (event, projectId, subDir) => {
        const dirPath = path.join(mlDir(projectId), subDir || '');
        try {
            const items = await fs.readdir(dirPath, {withFileTypes: true});
            return items.filter(i => i.isFile()).map(i => i.name);
        } catch (_) { return []; }
    });

    /* Delete a single file from the ML project directory */
    ipcMain.handle('ml-delete-file', async (event, projectId, relativePath) => {
        try { await fs.unlink(path.join(mlDir(projectId), relativePath)); } catch (_) {}
    });

    /* Remove the entire ML project directory */
    ipcMain.handle('ml-delete-project', async (event, projectId) => {
        try { await fs.remove(mlDir(projectId)); } catch (_) {}
    });

    /* List all ML projects — scan <userData>/ml-projects/ and return each project.json */
    ipcMain.handle('ml-list-projects', async () => {
        const root = path.join(app.getPath('userData'), 'ml-projects');
        try {
            await fs.ensureDir(root);
            const entries = await fs.readdir(root, {withFileTypes: true});
            const projects = [];
            for (const entry of entries) {
                if (!entry.isDirectory()) continue;
                const metaPath = path.join(root, entry.name, 'project.json');
                try {
                    const raw = await fs.readFile(metaPath, 'utf8');
                    const meta = JSON.parse(raw);
                    if (meta && meta.id && meta.name) {
                        /* Ensure required fields always have safe defaults */
                        projects.push({
                            type:    'images',
                            labels:  [],
                            trained: false,
                            ...meta
                        });
                    }
                } catch (_) { /* skip corrupted/missing project.json */ }
            }
            /* Sort newest first */
            projects.sort((a, b) => (b.savedAt || b.createdAt || 0) - (a.savedAt || a.createdAt || 0));
            return projects;
        } catch (e) {
            log.error('[main] ml-list-projects failed:', e.message);
            return [];
        }
    });

    /* Renderer tells us which project is active so will-download knows what to bundle */
    ipcMain.on('ml-set-pending-project', (event, projectId) => {
        _pendingMLProjectId = projectId;
    });

    /* Clear the pending project when it is deleted so will-download doesn't try to bundle
       a directory that no longer exists, which would stall the next project open/save. */
    ipcMain.on('ml-clear-pending-project', (event, projectId) => {
        if (!projectId || _pendingMLProjectId === projectId) {
            _pendingMLProjectId = null;
        }
    });

    /* Check whether the ML model bundled inside a .ob file still exists on disk.
       Called before loading so the renderer can warn the user if the model was deleted. */
    ipcMain.handle('ml-check-ob-model', async (event, filePath) => {
        if (!filePath) return {hasMLData: false};
        try {
            const JSZip = require('jszip');
            const fileBuffer = await fs.readFile(filePath);
            const zip = await JSZip.loadAsync(fileBuffer);
            const metaKey = Object.keys(zip.files).find(
                k => k.startsWith('ml/') && k.endsWith('/project.json')
            );
            if (!metaKey) return {hasMLData: false};
            const raw = await zip.files[metaKey].async('string');
            const meta = JSON.parse(raw);
            if (!meta || !meta.id) return {hasMLData: false};
            const exists = await fs.pathExists(mlDir(meta.id));
            return {hasMLData: true, mlDeleted: !exists, projectId: meta.id, projectName: meta.name || ''};
        } catch (e) {
            log.warn('[main] ml-check-ob-model failed:', e.message);
            return {hasMLData: false};
        }
    });

    /* Explicit ML save dialog — bundles the ML filesystem directory into a new .ob ZIP */
    ipcMain.handle('ml-save-ob-file', async (event, projectId, projectName) => {
        const userPath = dialog.showSaveDialogSync(_windows.main, {
            title:       'Save ML Project',
            defaultPath: `${projectName || 'ml-project'}.ob`,
            filters:     [{name: 'OpenBlock Project', extensions: ['ob']}]
        });
        if (!userPath) return {success: false, canceled: true};
        try {
            const JSZip = require('jszip');
            const zip   = new JSZip();
            await bundleMLDir(zip, projectId);

            /* A valid root project.json is required so the blocks editor can open this .ob */
            const minimalProject = JSON.stringify({
                targets: [{
                    isStage: true, name: 'Stage',
                    variables: {}, lists: {}, broadcasts: {}, blocks: {}, comments: {},
                    currentCostume: 0,
                    costumes: [{
                        name: 'backdrop1', dataFormat: 'svg',
                        assetId: 'cd21514d0531fdffb22204e0ec5ed84a',
                        md5ext: 'cd21514d0531fdffb22204e0ec5ed84a.svg',
                        rotationCenterX: 240, rotationCenterY: 180
                    }],
                    sounds: [], volume: 100, layerOrder: 0,
                    tempo: 60, videoTransparency: 50, videoState: 'on', textToSpeechLanguage: null
                }],
                monitors: [], extensions: [],
                meta: {semver: '3.0.0', vm: '0.2.0', agent: 'RoboCoders-studio'}
            });
            zip.file('project.json', minimalProject);

            const buf = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
            await fs.writeFile(userPath, buf);
            return {success: true, path: userPath};
        } catch (e) {
            return {success: false, error: e.message};
        }
    });

    /* Renderer tells us which .ob file path is currently open (for in-app File → Open). */
    ipcMain.on('ml-update-current-file', (event, filePath) => {
        if (filePath) {
            _lastOpenedFilePath     = filePath;
            _currentProjectFilePath = filePath;
            /* Opening a different file makes the old pending ML project irrelevant */
            _pendingMLProjectId = null;
            /* Notify ML training pages that a new project file is active */
            if (_windows.main) _windows.main.webContents.send('ml-project-file-changed');
        }
    });

    /* Returns the current project file path (or null) — used by renderer to decide Save vs Save As */
    ipcMain.handle('get-current-project-path', () => _currentProjectFilePath);

    /* Clears the current project path — called when the user returns to the home screen so that
       re-entering the blocks editor always starts as an unsaved new project. */
    ipcMain.handle('clear-current-project-path', () => {
        _currentProjectFilePath = null;
    });

    /* Atomically write buf to targetPath: write to a temp file first, then rename.
       This prevents partial/corrupted files if the process crashes mid-write. */
    const atomicWriteFile = async (targetPath, buf) => {
        const tmpPath = targetPath + '.tmp';
        try {
            await fs.writeFile(tmpPath, buf);
            await fs.move(tmpPath, targetPath, {overwrite: true});
        } catch (e) {
            // Clean up orphaned temp file on failure
            try { await fs.unlink(tmpPath); } catch (_) {}
            throw e;
        }
    };

    /* Silent save: write project data directly to the current file path, no dialog.
       Uses atomic write (temp → rename) to prevent corruption on crash.
       Optional thumbnailData (Buffer) is stored as thumbnail.png inside the ZIP. */
    ipcMain.handle('save-project-to-current-file', async (event, projectData, thumbnailData) => {
        if (!_currentProjectFilePath) return {success: false, error: 'no-path'};
        try {
            const JSZip = require('jszip');
            const buf   = Buffer.isBuffer(projectData) ? projectData : Buffer.from(projectData);
            const zip   = await JSZip.loadAsync(buf);

            /* Bundle ML data; if it fails, abort the save so user isn't left with a broken file */
            if (_pendingMLProjectId) {
                try {
                    await bundleMLDir(zip, _pendingMLProjectId);
                } catch (mlErr) {
                    log.error('[main] ML bundling failed, aborting save:', mlErr.message);
                    return {success: false, error: `ML bundling failed: ${mlErr.message}`};
                }
                _pendingMLProjectId = null;
            } else {
                /* No new ML export — carry forward any existing ml/ entries from the current file
                   so the model is preserved across repeated saves (e.g. auto-save, second Ctrl+S). */
                try {
                    const existingBuf = await fs.readFile(_currentProjectFilePath);
                    const existingZip = await JSZip.loadAsync(existingBuf);
                    for (const [key, file] of Object.entries(existingZip.files)) {
                        if (key.startsWith('ml/') && !file.dir) {
                            zip.file(key, await file.async('nodebuffer'));
                        }
                    }
                } catch (_) { /* no existing ml data — that's fine */ }
            }

            if (thumbnailData) {
                zip.file('thumbnail.png', Buffer.isBuffer(thumbnailData) ? thumbnailData : Buffer.from(thumbnailData));
            }

            const newBuf = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
            await atomicWriteFile(_currentProjectFilePath, newBuf);
            const ext   = path.extname(_currentProjectFilePath);
            const title = path.basename(_currentProjectFilePath, ext);
            return {success: true, title};
        } catch (e) {
            log.error('[main] save-project-to-current-file failed:', e.message);
            return {success: false, error: e.message};
        }
    });

    /* Save project data to an explicit path (used for Save As + "Save before open" flows).
       Updates _currentProjectFilePath so subsequent Ctrl+S hits the same file.
       Uses atomic write (temp → rename) to prevent corruption on crash.
       Optional thumbnailData (Buffer) is stored as thumbnail.png inside the ZIP. */
    ipcMain.handle('save-project-to-path', async (event, filePath, projectData, thumbnailData) => {
        if (!filePath) return {success: false, error: 'no-path'};
        try {
            const JSZip = require('jszip');
            const buf   = Buffer.isBuffer(projectData) ? projectData : Buffer.from(projectData);
            const zip   = await JSZip.loadAsync(buf);

            /* Bundle ML data; abort on failure to prevent incomplete files */
            if (_pendingMLProjectId) {
                try {
                    await bundleMLDir(zip, _pendingMLProjectId);
                } catch (mlErr) {
                    log.error('[main] ML bundling failed, aborting save-to-path:', mlErr.message);
                    return {success: false, error: `ML bundling failed: ${mlErr.message}`};
                }
                _pendingMLProjectId = null;
            } else if (_currentProjectFilePath) {
                /* No new ML export — carry forward any existing ml/ entries from the current file
                   (handles Save As when the existing file already has ML data). */
                try {
                    const existingBuf = await fs.readFile(_currentProjectFilePath);
                    const existingZip = await JSZip.loadAsync(existingBuf);
                    for (const [key, file] of Object.entries(existingZip.files)) {
                        if (key.startsWith('ml/') && !file.dir) {
                            zip.file(key, await file.async('nodebuffer'));
                        }
                    }
                } catch (_) { /* no existing ml data — that's fine */ }
            }

            if (thumbnailData) {
                zip.file('thumbnail.png', Buffer.isBuffer(thumbnailData) ? thumbnailData : Buffer.from(thumbnailData));
            }

            const newBuf = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE'});
            await atomicWriteFile(filePath, newBuf);
            _currentProjectFilePath = filePath;
            const title = path.basename(filePath, path.extname(filePath));
            return {success: true, title};
        } catch (e) {
            log.error('[main] save-project-to-path failed:', e.message);
            return {success: false, error: e.message};
        }
    });

    /* ══════════════════════════════════════════════════════════════
       Recent files — stored in electron-store, max 10 entries
       Each entry: { filePath, title, openedAt }
       ══════════════════════════════════════════════════════════════ */
    const MAX_RECENT_FILES = 10;

    const addRecentFile = (filePath, title) => {
        if (!filePath) return;
        let recents = storage.get('recentFiles', []);
        // Remove duplicate (same path)
        recents = recents.filter(r => r.filePath !== filePath);
        recents.unshift({filePath, title: title || path.basename(filePath, path.extname(filePath)), openedAt: Date.now()});
        if (recents.length > MAX_RECENT_FILES) recents = recents.slice(0, MAX_RECENT_FILES);
        storage.set('recentFiles', recents);
    };

    ipcMain.handle('add-recent-file', (event, filePath, title) => {
        addRecentFile(filePath, title);
    });

    ipcMain.handle('get-recent-files', () => {
        const recents = storage.get('recentFiles', []);
        // Filter out files that no longer exist on disk
        return recents.filter(r => {
            try { return fs.existsSync(r.filePath); } catch (_) { return false; }
        });
    });

    ipcMain.handle('clear-recent-files', () => {
        storage.delete('recentFiles');
    });

    /* ══════════════════════════════════════════════════════════════
       Crash-recovery backup handlers
       Backup lives at: <userData>/crash-backup/backup.ob
                        <userData>/crash-backup/meta.json
       ══════════════════════════════════════════════════════════════ */
    const crashBackupDir  = path.join(app.getPath('userData'), 'crash-backup');
    const crashBackupFile = path.join(crashBackupDir, 'backup.ob');
    const crashBackupMeta = path.join(crashBackupDir, 'meta.json');

    /* Write (or overwrite) the crash backup. Called by renderer every few minutes when dirty. */
    ipcMain.handle('write-crash-backup', async (event, projectData, originalFilePath) => {
        try {
            await fs.ensureDir(crashBackupDir);
            const buf = Buffer.isBuffer(projectData) ? projectData : Buffer.from(projectData);
            await fs.writeFile(crashBackupFile, buf);
            await fs.writeFile(crashBackupMeta, JSON.stringify({
                originalFilePath: originalFilePath || null,
                savedAt: Date.now()
            }));
            return {success: true};
        } catch (e) {
            log.error('[main] write-crash-backup failed:', e.message);
            return {success: false};
        }
    });

    /* Delete the backup on clean exit. */
    ipcMain.handle('clear-crash-backup', async () => {
        try {
            await fs.remove(crashBackupDir);
        } catch (_) {}
    });

    /* Check if a backup exists. Returns {exists, originalFilePath, savedAt} or {exists: false}. */
    ipcMain.handle('check-crash-backup', async () => {
        try {
            const exists = await fs.pathExists(crashBackupFile);
            if (!exists) return {exists: false};
            const meta = JSON.parse(await fs.readFile(crashBackupMeta, 'utf8'));
            return {exists: true, originalFilePath: meta.originalFilePath, savedAt: meta.savedAt};
        } catch (_) {
            return {exists: false};
        }
    });

    /* Return the backup file buffer so the renderer can load it. */
    ipcMain.handle('read-crash-backup', async () => {
        try { return await fs.readFile(crashBackupFile); }
        catch (_) { return null; }
    });

    /* Load ML project metadata for a training page on mount.
       Priority:
         1. Native project: project.json already exists on disk in the ml-projects dir
            (created/saved from within the app — the common case).
         2. .ob file: extract ml/ from the open .ob ZIP into the project dir, then read.
       Returns: project.json metadata object | {noMlData: true} | {loadError: string} */
    ipcMain.handle('ml-get-loaded-data', async (event, projectId) => {
        if (!projectId) return {noMlData: true};

        /* ── Priority 1: native project already on disk ── */
        const nativeMetaPath = path.join(mlDir(projectId), 'project.json');
        if (await fs.pathExists(nativeMetaPath)) {
            try {
                const raw = await fs.readFile(nativeMetaPath, 'utf8');
                return JSON.parse(raw);
            } catch (e) {
                log.warn('[main] ml-get-loaded-data: could not parse native project.json:', e.message);
                /* fall through to .ob extraction */
            }
        }

        /* ── Priority 2: extract from open .ob file ── */
        /* Always prefer _lastOpenedFilePath (updated on every File > Open) over argv._ so
           that opening a second .ob file after launch doesn't read from the first one. */
        const projectPath = _lastOpenedFilePath ||
            (argv._.length > 0 ? argv._[argv._.length - 1] : null);
        if (!projectPath) return {noMlData: true};
        try {
            const JSZip      = require('jszip');
            const fileBuffer = await fs.readFile(projectPath);
            const zip        = await JSZip.loadAsync(fileBuffer);
            const hasMl      = Object.keys(zip.files).some(k => k.startsWith('ml/'));
            if (!hasMl) return {noMlData: true};
            await extractMLDir(zip, projectId);
            const metaPath = path.join(mlDir(projectId), 'project.json');
            try {
                let meta = JSON.parse(await fs.readFile(metaPath, 'utf8'));
                /* The .ob was created with a possibly-different project id. Stamp it with
                   the session id so the training page can reliably find its data. */
                if (meta.id && meta.id !== projectId) {
                    meta = {...meta, id: projectId};
                    await fs.writeFile(metaPath, JSON.stringify(meta));
                }
                return meta;
            } catch (_) {
                return {restored: true};
            }
        } catch (e) {
            log.error('[main] ml-get-loaded-data failed:', e.message);
            return {loadError: e.message};
        }
    });

    /* ── Read ML metadata from the open .ob file without extracting ── */
    ipcMain.handle('ml-preload-active-model', async () => {
        /* Always prefer _lastOpenedFilePath over argv._ — it is updated on every File > Open,
           whereas argv._ is fixed at launch and would point to the wrong file after re-open. */
        const projectPath = _lastOpenedFilePath ||
            (argv._.length > 0 ? argv._[argv._.length - 1] : null);
        if (!projectPath) return null;
        try {
            const JSZip = require('jszip');
            const fileBuffer = await fs.readFile(projectPath);
            const zip = await JSZip.loadAsync(fileBuffer);
            const metaKey = Object.keys(zip.files).find(
                k => k.startsWith('ml/') && k.endsWith('/project.json')
            );
            if (!metaKey) return null;
            const raw = await zip.files[metaKey].async('string');
            return JSON.parse(raw);
        } catch (e) {
            log.warn('[main] ml-preload-active-model failed:', e.message);
            return null;
        }
    });

    if (isDevelopment) {
        import('electron-devtools-installer').then(importedModule => {
            const {default: installExtension, ...devToolsExtensions} = importedModule;
            const extensionsToInstall = [
                devToolsExtensions.REACT_DEVELOPER_TOOLS,
                devToolsExtensions.REDUX_DEVTOOLS
            ];
            for (const extension of extensionsToInstall) {
                // WARNING: depending on a lot of things including the version of Electron `installExtension` might
                // return a promise that never resolves, especially if the extension is already installed.
                try {
                    installExtension(extension).then(
                        extensionName => log(`Installed dev extension: ${extensionName}`),
                        errorMessage => log.error(`Error installing dev extension: ${errorMessage}`)
                    ).catch(err => log.error(`Dev extension install failed: ${err}`));
                } catch (err) {
                    log.error(`Dev extension install threw: ${err}`);
                }
            }
        }).catch(err => log.error(`Failed to load electron-devtools-installer: ${err}`));
    }

    ipcMain.on('clearCache', () => {
        desktopLink.clearCache();
    });

    ipcMain.on('installDriver', () => {
        desktopLink.installDriver(() => {
            dialog.showMessageBox(_windows.main, {
                type: 'info',
                message: `${formatMessage({
                    id: 'index.systemRestartRequired',
                    default: 'Installation is complete, please restart the system.',
                    description: 'prompt for restart system'
                })}`
            });
        });
    });

    // create a loading windows let user know the app is starting
    _windows.loading = createLoadingWindow();
    _windows.loading.once('show', () => {
        desktopLink.start();

        _windows.main = createMainWindow();
        _windows.main.on('closed', () => {
            delete _windows.main;
        });

        _windows.about = createAboutWindow();
        _windows.about.on('close', event => {
            event.preventDefault();
            _windows.about.hide();
        });
        _windows.license = createLicenseWindow();
        _windows.license.on('close', event => {
            event.preventDefault();
            _windows.license.hide();
        });
        _windows.privacy = createPrivacyWindow();
        _windows.privacy.on('close', event => {
            event.preventDefault();
            _windows.privacy.hide();
        });

        // after finsh load progress show main window and close loading window
        _windows.main.show();
        _windows.loading.close();
        delete _windows.loading;
    });
});

// start loading initial project data before the GUI needs it so the load seems faster
const initialProjectDataPromise = (async () => {
    if (argv._.length === 0) {
        // no command line argument means no initial project data
        return;
    }
    if (argv._.length > 1) {
        log.warn(`Expected 1 command line argument but received ${argv._.length}.`);
    }
    const projectPath = argv._[argv._.length - 1];
    /* Seed file trackers so Save and ml-get-loaded-data work on CLI-opened files */
    _lastOpenedFilePath    = projectPath;
    _currentProjectFilePath = projectPath;
    try {
        const projectData = await promisify(fs.readFile)(projectPath, null);
        return projectData;
    } catch (e) {
        dialog.showMessageBox(_windows.main, {
            type: 'error',
            title: 'Failed to load project',
            message: `${formatMessage({
                id: 'index.failedLoadProject',
                default: 'Could not load project from file:',
                description: 'prompt for failed to load project'
            })}\n${projectPath}`,
            detail: e.message
        });
    }
    // load failed: initial project data undefined
})(); // IIFE

ipcMain.handle('get-initial-project-data', () => initialProjectDataPromise);

ipcMain.on('open-about-window', () => {
    _windows.about.show();
});

ipcMain.on('open-license-window', () => {
    _windows.license.show();
});

ipcMain.on('open-privacy-policy-window', () => {
    _windows.privacy.show();
});

ipcMain.on('set-locale', (event, arg) => {
    formatMessage.setup({locale: arg});
});
