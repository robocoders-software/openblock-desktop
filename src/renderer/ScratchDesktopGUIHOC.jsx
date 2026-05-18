import {ipcRenderer, clipboard} from 'electron';
import * as remote from '@electron/remote/renderer';
import showAppDialog from 'openblock-gui/src/lib/app-dialog-service.js';
import bindAll from 'lodash.bindall';
import omit from 'lodash.omit';
import PropTypes from 'prop-types';
import React from 'react';
import {connect} from 'react-redux';
import GUIComponent from 'openblock-gui/src/components/gui/gui.jsx';
import {FormattedMessage} from 'react-intl';

import {
    LoadingStates,
    onFetchedProjectData,
    onLoadedProject,
    defaultProjectId,
    requestNewProject,
    requestProjectUpload,
    setProjectId
} from 'openblock-gui/src/reducers/project-state';
import {
    openLoadingProject,
    closeLoadingProject,
    openTelemetryModal,
    openUpdateModal
} from 'openblock-gui/src/reducers/modals';
import {setProjectTitle} from 'openblock-gui/src/reducers/project-title';
import {setUpdate} from 'openblock-gui/src/reducers/update';
import {setDeviceData} from 'openblock-gui/src/reducers/device-data';

import analytics, {initialAnalytics} from 'openblock-gui/src/lib/analytics';
import MessageBoxType from 'openblock-gui/src/lib/message-box.js';
import {makeDeviceLibrary} from 'openblock-gui/src/lib/libraries/devices/index.jsx';

import ElectronStorageHelper from '../common/ElectronStorageHelper';

import showPrivacyPolicy from './showPrivacyPolicy';

/**
 * Higher-order component to add desktop logic to the GUI.
 * @param {Component} WrappedComponent - a GUI-like component to wrap.
 * @returns {Component} - a component similar to GUI with desktop-specific logic added.
 */
const ScratchDesktopGUIHOC = function (WrappedComponent) {
    class ScratchDesktopGUIComponent extends React.Component {
        constructor (props) {
            super(props);
            this.state = {projectTitle: ''};
            bindAll(this, [
                'handleClickLogo',
                'handleDirectSave',
                'handleGoHome',
                'handleNewBlocksProject',
                'handleProjectDirtyChanged',
                'handleSaveBeforeOpen',
                'handleProjectTelemetryEvent',
                'handleSetTitleFromOpen',
                'handleSetTitleFromSave',
                'handleShowMessageBox',
                'handleStorageInit',
                'handleUpdateProjectTitle'
            ]);
            this.props.onLoadingStarted();
            ipcRenderer.invoke('get-initial-project-data').then(async initialProjectData => {
                const hasInitialProject = initialProjectData && (initialProjectData.length > 0);
                this.props.onHasInitialProject(hasInitialProject, this.props.loadingState);
                if (!hasInitialProject) {
                    this.props.onLoadingCompleted();
                    ipcRenderer.send('loading-completed');
                    return;
                }
                // Update device list
                await this.props.vm.extensionManager.getDeviceList().then(data => {
                    this.props.onSetDeviceData(makeDeviceLibrary(data));
                })
                    .catch(() => {
                        this.props.onSetDeviceData(makeDeviceLibrary());
                    });

                /* ── ML deleted-model check for files opened via double-click / CLI ──
                   When a .ob is opened this way it bypasses sb-file-uploader-hoc, so
                   the check must happen here before vm.loadProject extracts ml/ data. */
                try {
                    const initialFilePath = await ipcRenderer.invoke('get-initial-file-path');
                    if (initialFilePath && /\.ob$/i.test(initialFilePath)) {
                        const mlCheck = await ipcRenderer.invoke('ml-check-ob-model', initialFilePath);
                        if (mlCheck && mlCheck.mlDeleted) {
                            const name = mlCheck.projectName || 'Unknown';
                            const idx = await showAppDialog({
                                type: 'warning',
                                title: 'ML Model Not Found',
                                message: `The ML model "${name}" used in this project has been deleted.`,
                                detail: 'You can continue without ML blocks, or cancel.',
                                buttons: ['Continue without ML blocks', 'Cancel'],
                                defaultId: 0
                            });
                            if (idx === 1) {
                                /* User cancelled — abort load, start fresh */
                                this.props.onLoadingCompleted();
                                ipcRenderer.send('loading-completed');
                                this.props.onHasInitialProject(false, this.props.loadingState);
                                this.props.onRequestNewProject();
                                return;
                            }
                            window.__openblockMLSkipRestore = true;
                            ipcRenderer.send('ml-set-skip-restore', true);
                        }
                    }
                } catch (_) { /* ML check failed — proceed normally */ }

                this.props.vm.loadProject(initialProjectData).then(
                    () => {
                        this.props.onLoadingCompleted();
                        ipcRenderer.send('loading-completed');
                        this.props.onLoadedProject(this.props.loadingState, true);
                    },
                    e => {
                        this.props.onLoadingCompleted();
                        ipcRenderer.send('loading-completed');
                        this.props.onLoadedProject(this.props.loadingState, false);
                        showAppDialog({
                            type: 'error',
                            title: 'Failed to load project',
                            message: 'Invalid or corrupt project file.',
                            detail: e.message
                        });

                        // this effectively sets the default project ID
                        // TODO: maybe setting the default project ID should be implicit in `requestNewProject`
                        this.props.onHasInitialProject(false, this.props.loadingState);

                        // restart as if we didn't have an initial project to load
                        this.props.onRequestNewProject();
                    }
                );
            });
            ipcRenderer.send('set-locale', this.props.locale);
        }
        componentDidMount () {
            // replace navigator.clipboard.readText to Electron's clipboard.readText
            navigator.clipboard.readText = () => Promise.resolve(clipboard.readText());

            ipcRenderer.on('setTitleFromSave', this.handleSetTitleFromSave);
            ipcRenderer.on('setTitleFromOpen', this.handleSetTitleFromOpen);
            ipcRenderer.on('setUpdate', (event, args) => {
                this.props.onSetUpdate(args);
            });
            ipcRenderer.on('setUserId', (event, args) => {
                initialAnalytics(args);
                // Register "base" page view
                analytics.send({hitType: 'pageview', page: '/community/electron'});
            });
            ipcRenderer.on('setPlatform', (event, args) => {
                this.platform = args;
            });

            // Track last-saved time and sync dirty state to window title
            this._lastSavedAt = null;
            this._projectDirty = false;

            // Auto-save to the current file every 2 minutes when dirty and a file path exists
            const AUTO_SAVE_INTERVAL_MS = 2 * 60 * 1000;
            this._autoSaveInterval = setInterval(async () => {
                if (!this._projectDirty) return;
                const hasPath = await ipcRenderer.invoke('get-current-project-path');
                if (!hasPath) return;
                // Use a no-op fallback: if save fails we do nothing (user still has dirty state)
                this.handleDirectSave(() => {});
            }, AUTO_SAVE_INTERVAL_MS);

            // Write crash-recovery backup every 3 minutes when dirty
            const BACKUP_INTERVAL_MS = 3 * 60 * 1000;
            this._backupInterval = setInterval(async () => {
                if (!this._projectDirty) return;
                try {
                    const content  = await this.props.vm.saveProjectSb3();
                    const arrayBuf = await content.arrayBuffer();
                    const filePath = await ipcRenderer.invoke('get-current-project-path');
                    await ipcRenderer.invoke('write-crash-backup', Buffer.from(arrayBuf), filePath);
                } catch (_) { /* backup is best-effort */ }
            }, BACKUP_INTERVAL_MS);

            // Register new-project callback so app.jsx can trigger a fresh project
            // without unmounting/remounting this component (avoids storage re-init race)
            if (this.props.onRegisterNewProject) {
                this.props.onRegisterNewProject(() => {
                    // Clear Redux project title and OS window title for the fresh project
                    this.handleUpdateProjectTitle('');
                    ipcRenderer.send('project-dirty-changed', {dirty: false, title: ''});
                    // Reset save-status display: clear timestamp and dirty flag
                    this._lastSavedAt = null;
                    this._projectDirty = false;
                    this.forceUpdate();
                    // New project = old crash backup is no longer relevant
                    ipcRenderer.invoke('clear-crash-backup').catch(() => {});
                    // Clear the active ML model reference so it doesn't auto-load into the new project
                    if (typeof window !== 'undefined') window.__openblockMLModel = null;
                    // Explicitly unload the teachableMachine extension from the VM so its blocks
                    // don't appear in the fresh project's toolbox (VM doesn't unload extensions
                    // automatically when a new project is loaded)
                    if (this.props.vm && this.props.vm.extensionManager &&
                        this.props.vm.extensionManager.isExtensionLoaded('teachableMachine')) {
                        this.props.vm.extensionManager.unloadExtension('teachableMachine');
                    }
                    // Notify gui.jsx to reset only the transient loading/pending ML states
                    window.dispatchEvent(new CustomEvent('robocoders:new-project'));
                    this.props.onRequestNewProject();
                });
            }

            // Check for a crash backup from a previous session
            this._checkCrashBackup();
        }
        componentWillUnmount () {
            ipcRenderer.removeListener('setTitleFromSave', this.handleSetTitleFromSave);
            ipcRenderer.removeListener('setTitleFromOpen', this.handleSetTitleFromOpen);
            if (this._autoSaveInterval) {
                clearInterval(this._autoSaveInterval);
                this._autoSaveInterval = null;
            }
            if (this._backupInterval) {
                clearInterval(this._backupInterval);
                this._backupInterval = null;
            }
            // Clean up backup on graceful unmount (clean exit)
            if (!this._projectDirty) {
                ipcRenderer.invoke('clear-crash-backup').catch(() => {});
            }
        }
        async _checkCrashBackup () {
            try {
                const info = await ipcRenderer.invoke('check-crash-backup');
                if (!info || !info.exists) return;
                const savedAt = info.savedAt ? new Date(info.savedAt).toLocaleString() : 'unknown time';
                const choice = await showAppDialog({
                    type: 'question',
                    title: 'Unsaved Project Backup Found',
                    message: 'RoboCoders Studio closed unexpectedly.',
                    detail: `A backup from ${savedAt} was found${info.originalFilePath ? `\n(${info.originalFilePath})` : ''}.\n\nRestore it?`,
                    buttons: ['Restore Backup', 'Discard'],
                    defaultId: 0
                });
                if (choice === 0) {
                    const backupData = await ipcRenderer.invoke('read-crash-backup');
                    if (backupData) {
                        await this.props.vm.loadProject(backupData.buffer || backupData);
                        if (info.originalFilePath) {
                            const title = require('path').basename(
                                info.originalFilePath,
                                require('path').extname(info.originalFilePath)
                            );
                            this.handleUpdateProjectTitle(title);
                            // Re-register the path so Ctrl+S saves to the right file
                            await ipcRenderer.invoke('save-project-to-path', info.originalFilePath, backupData);
                        }
                    }
                }
                // Always clear backup after showing the dialog (restored or discarded)
                await ipcRenderer.invoke('clear-crash-backup');
            } catch (_) { /* backup check is best-effort */ }
        }
        handleClickLogo () {
            ipcRenderer.send('open-about-window');
        }
        async handleGoHome () {
            if (this._projectDirty) {
                const choice = await showAppDialog({
                    type: 'question',
                    title: 'Unsaved Changes',
                    message: 'You have unsaved changes.',
                    detail: 'Save your project before returning to the home screen?',
                    buttons: ['Save & Go Home', "Don't Save", 'Cancel'],
                    defaultId: 0
                });
                if (choice === 2) return;
                if (choice === 0) await this.handleDirectSave(() => {});
            }
            // Intentional navigation — clear crash backup so it doesn't appear as a
            // "closed unexpectedly" dialog on the next launch.
            ipcRenderer.invoke('clear-crash-backup').catch(() => {});
            this._projectDirty = false;
            // Clear ML model so it doesn't persist into the next blocks session
            if (typeof window !== 'undefined') window.__openblockMLModel = null;
            // Reset window title to app name while on home screen (no active project)
            ipcRenderer.send('project-dirty-changed', {dirty: false, title: ''});
            // Clear the saved file path so re-entering blocks starts as a new unsaved project
            ipcRenderer.invoke('clear-current-project-path').catch(() => {});
            if (this.props.onGoHome) this.props.onGoHome();
        }
        async handleNewBlocksProject () {
            if (this._projectDirty) {
                const choice = await showAppDialog({
                    type: 'question',
                    title: 'Unsaved Changes',
                    message: 'You have unsaved changes.',
                    detail: 'Save before creating a new project?',
                    buttons: ['Save', "Don't Save", 'Cancel'],
                    defaultId: 0
                });
                if (choice === 2) return;
                if (choice === 0) {
                    await this.handleSaveBeforeOpen();
                    // User cancelled the Save As dialog — _projectDirty stays true; abort new project
                    if (this._projectDirty) return;
                }
            }
            this.handleUpdateProjectTitle('');
            ipcRenderer.send('project-dirty-changed', {dirty: false, title: ''});
            this._lastSavedAt = null;
            this._projectDirty = false;
            this.forceUpdate();
            ipcRenderer.invoke('clear-crash-backup').catch(() => {});
            ipcRenderer.invoke('clear-current-project-path').catch(() => {});
            if (typeof window !== 'undefined') window.__openblockMLModel = null;
            if (this.props.vm && this.props.vm.extensionManager &&
                this.props.vm.extensionManager.isExtensionLoaded('teachableMachine')) {
                this.props.vm.extensionManager.unloadExtension('teachableMachine');
            }
            window.dispatchEvent(new CustomEvent('robocoders:new-project'));
            this.props.onRequestNewProject();
        }
        handleClickAbout () {
            ipcRenderer.send('open-about-window');
        }
        handleClickLicense () {
            ipcRenderer.send('open-license-window');
        }
        handleClickCheckUpdate () {
            ipcRenderer.send('requestCheckUpdate');
        }
        handleClickUpdate () {
            ipcRenderer.send('requestUpdate');
        }
        handleAbortUpdate () {
            ipcRenderer.send('abortUpdate');
        }
        handleClickClearCache () {
            ipcRenderer.send('clearCache');
        }
        handleClickInstallDriver () {
            ipcRenderer.send('installDriver');
        }
        handleProjectTelemetryEvent (event, metadata) {
            ipcRenderer.send(event, metadata);
        }
        // Called when the app was launched by opening a project file — updates the
        // menu-bar title and window title without touching save state or timestamps.
        handleSetTitleFromOpen (event, args) {
            this.handleUpdateProjectTitle(args.title);
            ipcRenderer.send('project-dirty-changed', {dirty: false, title: args.title});
            this.forceUpdate();
        }
        handleSetTitleFromSave (event, args) {
            this.handleUpdateProjectTitle(args.title);
            // Record save time and clear dirty flag
            this._lastSavedAt = Date.now();
            this._projectDirty = false;
            ipcRenderer.send('project-dirty-changed', {dirty: false, title: args.title});
            this.forceUpdate();
        }
        /* Called when project is modified (dirty) — updates window title and last-saved display */
        handleProjectDirtyChanged (dirty) {
            if (this._projectDirty === dirty) return;
            this._projectDirty = dirty;
            // Prefer local state title (post-save name), fall back to Redux title (initial load name)
            const title = (this.state && this.state.projectTitle) || this.props.reduxProjectTitle || '';
            ipcRenderer.send('project-dirty-changed', {dirty, title});
            this.forceUpdate();
        }
        /* Save before opening another project: overwrites current file, or shows Save As dialog.
           Returns a promise that resolves when saving is done (or skipped). */
        async handleSaveBeforeOpen () {
            let savePath = await ipcRenderer.invoke('get-current-project-path');
            if (!savePath) {
                /* No saved file yet — show Save As dialog synchronously.
                   Use Redux project title (from props/state) as the default filename. */
                const currentTitle = (this.state && this.state.projectTitle) ||
                    (this.props && this.props.projectTitle) || 'project';
                try {
                    const result = await remote.dialog.showSaveDialog({
                        title: 'Save Project',
                        defaultPath: `${currentTitle}.ob`,
                        filters: [{name: 'OpenBlock Project', extensions: ['ob']}]
                    });
                    savePath = result.canceled ? null : result.filePath;
                } catch (_) { /* not in Electron */ }
                if (!savePath) return; /* user cancelled Save As — proceed with open anyway */
            }
            try {
                const [content, thumbnail] = await Promise.all([
                    this.props.vm.saveProjectSb3(),
                    this._captureThumbnail()
                ]);
                const arrayBuf = await content.arrayBuffer();
                const result   = await ipcRenderer.invoke('save-project-to-path', savePath, Buffer.from(arrayBuf), thumbnail);
                if (result.success) {
                    // Sync renderer title and last-saved state after successful Save As
                    this.handleUpdateProjectTitle(result.title);
                    this._lastSavedAt = Date.now();
                    this._projectDirty = false;
                    ipcRenderer.send('project-dirty-changed', {dirty: false, title: result.title});
                    ipcRenderer.invoke('clear-crash-backup').catch(() => {});
                    ipcRenderer.invoke('add-recent-file', savePath, result.title).catch(() => {});
                }
            } catch (e) {
                log.error('[renderer] handleSaveBeforeOpen failed:', e.message);
                /* silent — opening will still proceed */
            }
        }

        /* Save to current file path without a dialog; falls back to SB3Downloader if no path. */
        async handleDirectSave (downloadProjectFallback) {
            const hasPath = await ipcRenderer.invoke('get-current-project-path');
            if (!hasPath) {
                /* First save — no file chosen yet, delegate to the download flow */
                downloadProjectFallback();
                return;
            }
            try {
                const [content, thumbnail] = await Promise.all([
                    this.props.vm.saveProjectSb3(),
                    this._captureThumbnail()
                ]);
                const arrayBuf = await content.arrayBuffer();
                const result   = await ipcRenderer.invoke(
                    'save-project-to-current-file',
                    Buffer.from(arrayBuf),
                    thumbnail
                );
                if (result.success) {
                    this.handleUpdateProjectTitle(result.title);
                    // Record successful save — clears dirty indicator and last-saved timestamp
                    this._lastSavedAt = Date.now();
                    this._projectDirty = false;
                    ipcRenderer.send('project-dirty-changed', {dirty: false, title: result.title});
                    ipcRenderer.invoke('clear-crash-backup').catch(() => {});
                    ipcRenderer.invoke('add-recent-file', hasPath, result.title).catch(() => {});
                    this.forceUpdate();
                } else {
                    log.warn('[renderer] handleDirectSave failed:', result.error);
                    /* Write failed — fall back to Save As dialog */
                    downloadProjectFallback();
                }
            } catch (e) {
                log.error('[renderer] handleDirectSave threw:', e.message);
                downloadProjectFallback();
            }
        }
        /* Capture a 480×360 PNG thumbnail from the stage canvas.
           Returns a Buffer, or null if capture fails. */
        _captureThumbnail () {
            return new Promise(resolve => {
                try {
                    this.props.vm.postIOData('video', {forceTransparentPreview: true});
                    this.props.vm.renderer.requestSnapshot(dataURI => {
                        this.props.vm.postIOData('video', {forceTransparentPreview: false});
                        try {
                            const base64 = dataURI.replace(/^data:image\/\w+;base64,/, '');
                            resolve(Buffer.from(base64, 'base64'));
                        } catch (_) { resolve(null); }
                    });
                    this.props.vm.renderer.draw();
                } catch (_) { resolve(null); }
            });
        }
        handleStorageInit (storageInstance) {
            storageInstance.addHelper(new ElectronStorageHelper(storageInstance));
            storageInstance.setAssetHost('https://robocoders-software.github.io/openblock-assets');
            storageInstance.addOfficialScratchWebStores();
        }
        handleUpdateProjectTitle (newTitle) {
            this.setState({projectTitle: newTitle});
            // Also sync to Redux so project-saver and title input stay consistent
            this.props.onSetProjectTitle(newTitle);
        }
        handleShowMessageBox (type, message) {
            if (type === MessageBoxType.confirm) {
                return showAppDialog({
                    type: 'question',
                    title: 'Confirm',
                    message,
                    buttons: ['OK', 'Cancel'],
                    defaultId: 0
                }).then(idx => idx === 0);
            }
            return showAppDialog({
                type: 'info',
                title: 'Notice',
                message,
                buttons: ['OK'],
                defaultId: 0
            });
        }
        render () {
            const childProps = omit(this.props, Object.keys(ScratchDesktopGUIComponent.propTypes));

            return (<WrappedComponent
                canEditTitle
                canChangeLanguage={false}
                canModifyCloudData={false}
                canSave={false}
                isScratchDesktop
                onClickAbout={[
                    {
                        title: (<FormattedMessage
                            defaultMessage="About"
                            description="Menu bar item for about"
                            id="gui.desktopMenuBar.about"
                        />),
                        onClick: () => this.handleClickAbout()
                    },
                    {
                        title: (<FormattedMessage
                            defaultMessage="License"
                            description="Menu bar item for license"
                            id="gui.desktopMenuBar.license"
                        />),
                        onClick: () => this.handleClickLicense()
                    },
                    {
                        title: (<FormattedMessage
                            defaultMessage="Privacy policy"
                            description="Menu bar item for privacy policy"
                            id="gui.menuBar.privacyPolicy"
                        />),
                        onClick: () => showPrivacyPolicy()
                    },
                    {
                        title: (<FormattedMessage
                            defaultMessage="Data settings"
                            description="Menu bar item for data settings"
                            id="gui.menuBar.dataSettings"
                        />),
                        onClick: () => this.props.onTelemetrySettingsClicked()
                    }
                ]}
                onGoHome={this.handleGoHome}
                onNewBlocksProject={this.handleNewBlocksProject}
                onClickLogo={this.handleClickLogo}
                onClickCheckUpdate={this.handleClickCheckUpdate}
                onClickUpdate={this.handleClickUpdate}
                onAbortUpdate={this.handleAbortUpdate}
                onClickInstallDriver={this.handleClickInstallDriver}
                onClickClearCache={this.handleClickClearCache}
                onDirectSave={this.handleDirectSave}
                onSaveBeforeOpen={this.handleSaveBeforeOpen}
                onProjectTelemetryEvent={this.handleProjectTelemetryEvent}
                onShowMessageBox={this.handleShowMessageBox}
                onShowPrivacyPolicy={showPrivacyPolicy}
                onStorageInit={this.handleStorageInit}
                onUpdateProjectTitle={this.handleUpdateProjectTitle}
                onProjectDirtyChanged={this.handleProjectDirtyChanged}
                lastSavedAt={this._lastSavedAt}
                projectDirty={this._projectDirty}

                // allow passed-in props to override any of the above
                {...childProps}
            />);
        }
    }

    ScratchDesktopGUIComponent.propTypes = {
        loadingState: PropTypes.oneOf(LoadingStates),
        locale: PropTypes.string.isRequired,
        onFetchedInitialProjectData: PropTypes.func,
        onHasInitialProject: PropTypes.func,
        onLoadedProject: PropTypes.func,
        onLoadingCompleted: PropTypes.func,
        onLoadingStarted: PropTypes.func,
        onRequestNewProject: PropTypes.func,
        onRegisterNewProject: PropTypes.func,
        onGoHome: PropTypes.func,
        onSetProjectTitle: PropTypes.func.isRequired,
        onTelemetrySettingsClicked: PropTypes.func,
        reduxProjectTitle: PropTypes.string,
        onSetDeviceData: PropTypes.func.isRequired,
        onSetUpdate: PropTypes.func,
        // using PropTypes.instanceOf(VM) here will cause prop type warnings due to VM mismatch
        vm: GUIComponent.WrappedComponent.propTypes.vm
    };
    const mapStateToProps = state => {
        const loadingState = state.scratchGui.projectState.loadingState;
        return {
            loadingState: loadingState,
            locale: state.locales.locale,
            reduxProjectTitle: state.scratchGui.projectTitle,
            vm: state.scratchGui.vm
        };
    };
    const mapDispatchToProps = dispatch => ({
        onLoadingStarted: () => dispatch(openLoadingProject()),
        onLoadingCompleted: () => dispatch(closeLoadingProject()),
        onHasInitialProject: (hasInitialProject, loadingState) => {
            if (hasInitialProject) {
                // emulate sb-file-uploader
                return dispatch(requestProjectUpload(loadingState));
            }

            // `createProject()` might seem more appropriate but it's not a valid state transition here
            // setting the default project ID is a valid transition from NOT_LOADED and acts like "create new"
            return dispatch(setProjectId(defaultProjectId));
        },
        onFetchedInitialProjectData: (projectData, loadingState) =>
            dispatch(onFetchedProjectData(projectData, loadingState)),
        onLoadedProject: (loadingState, loadSuccess) => {
            const canSaveToServer = false;
            return dispatch(onLoadedProject(loadingState, canSaveToServer, loadSuccess));
        },
        onRequestNewProject: () => dispatch(requestNewProject(false)),
        onSetDeviceData: data => dispatch(setDeviceData(data)),
        onSetProjectTitle: title => dispatch(setProjectTitle(title)),
        onSetUpdate: arg => {
            dispatch(setUpdate(arg));
            dispatch(openUpdateModal());
        },
        onTelemetrySettingsClicked: () => dispatch(openTelemetryModal())
    });

    return connect(mapStateToProps, mapDispatchToProps)(ScratchDesktopGUIComponent);
};

export default ScratchDesktopGUIHOC;
