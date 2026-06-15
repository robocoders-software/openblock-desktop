import React, {useState, useRef, useCallback, useEffect} from 'react';
import {compose} from 'redux';
import GUI from 'openblock-gui/src/index';
import AppStateHOC from 'openblock-gui/src/lib/app-state-hoc.jsx';
import showAppDialog from 'openblock-gui/src/lib/app-dialog-service.js';
import MLStudioApp, {loadImageProject, loadAudioProject, loadTextProject} from 'openblock-ml-studio';

import ScratchDesktopAppStateHOC from './ScratchDesktopAppStateHOC.jsx';
import ScratchDesktopGUIHOC from './ScratchDesktopGUIHOC.jsx';
import HomeScreen from './home-screen.jsx';
import styles from './app.css';

/* ── The full blocks GUI ── */
const WrappedGui = compose(
    ScratchDesktopAppStateHOC,
    AppStateHOC,
    ScratchDesktopGUIHOC
)(GUI);

const appTarget = document.getElementById('app');
appTarget.className = styles.app || 'app';
GUI.setAppElement(appTarget);

/* ── Root component ──────────────────────────────────
   WrappedGui is mounted ONCE on first "Blocks" selection
   and kept alive for the app's lifetime. Hiding it with
   display:none avoids the remount/re-initialization
   problem. Subsequent "Blocks" entries dispatch
   requestNewProject() via a registered callback instead.
──────────────────────────────────────────────────── */
const AppRoot = () => {
    const [mode, setMode] = useState('home'); // 'home' | 'blocks' | 'robotics' | 'ml'
    const [blocksReady, setBlocksReady] = useState(false);
    // Callback registered by ScratchDesktopGUIHOC once the editor is ready
    const newProjectCbRef = useRef(null);
    // True when the user reached ML Studio via the home screen (not via "Open ML Env" from blocks).
    // Used by enterBlocksFromML to decide whether to create a fresh project before exporting.
    const cameFromHomeRef = useRef(false);
    // Snapshot of window.__openblockMLModel taken just before entering ML Studio.
    // Restored on Back so that training a different model without exporting doesn't
    // silently overwrite the model that was active in the blocks editor.
    const savedMLModelRef = useRef(null);
    // The editor mode ('blocks' | 'robotics') active before entering ML Studio.
    // Used by ML Back and enterBlocksFromML to return to the right env.
    const preMlModeRef = useRef('blocks');
    // If the user deletes (in ML Studio) the model the OPEN blocks project depends on,
    // remember its {projectId,name,type,labels} so that on Back we warn the user and show
    // the correct block type (instead of the misleading image-led union).
    const deletedActiveModelRef = useRef(null);

    /* Listen for "Open ML Env" from within the blocks editor */
    useEffect(() => {
        const handler = () => {
            cameFromHomeRef.current = false;
            savedMLModelRef.current = window.__openblockMLModel || null;
            // Remember which editor we came from so Back returns to the right env
            setMode(prev => { preMlModeRef.current = prev; return 'ml'; });
        };
        window.addEventListener('robocoders:open-ml', handler);
        return () => window.removeEventListener('robocoders:open-ml', handler);
    }, []);

    /* The blocks GUI is mounted once and hidden with display:none when not active.
       While hidden its container is 0×0, so Blockly's workspace/flyout lose their
       sizing. Whenever we switch back to the blocks/robotics editor, dispatch a
       resize after the div is shown so Blockly re-measures and the palette/flyout
       render correctly. Two rAFs ensure the browser has laid the container out
       (display:none → block) before we measure. This keeps re-entry as robust as
       the first-mount path and prevents the "blocks not loaded" issue recurring. */
    useEffect(() => {
        if (!blocksReady) return;
        if (mode !== 'blocks' && mode !== 'robotics') return;
        const raf1 = requestAnimationFrame(() => {
            requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
        });
        return () => cancelAnimationFrame(raf1);
    }, [mode, blocksReady]);

    /* If the user deletes the model that was active in the blocks editor, don't restore it on
       Back — and remember its details so Back can warn the user and keep the correct block type. */
    useEffect(() => {
        const handler = e => {
            if (savedMLModelRef.current &&
                savedMLModelRef.current.projectId === e.detail.projectId) {
                const m = savedMLModelRef.current;
                deletedActiveModelRef.current = {
                    projectId: m.projectId,
                    name:      m.projectName || '',
                    type:      m.type || '',
                    labels:    m.labels || []
                };
                savedMLModelRef.current = null;
            }
        };
        window.addEventListener('robocoders:ml-model-deleted', handler);
        return () => window.removeEventListener('robocoders:ml-model-deleted', handler);
    }, []);

    /* Called from home screen "Blocks" button — resets to a blank project if returning */
    const enterBlocks = useCallback(() => {
        cameFromHomeRef.current = false;
        if (blocksReady && newProjectCbRef.current) {
            newProjectCbRef.current();
        }
        setBlocksReady(true);
        setMode('blocks');
    }, [blocksReady]);

    /* Called from home screen "Robotics" button */
    const enterRobotics = useCallback(() => {
        cameFromHomeRef.current = false;
        if (blocksReady) {
            // Editor already mounted — reset project then trigger board selection
            if (newProjectCbRef.current) newProjectCbRef.current();
            // Small delay so the editor is visible before the dialog appears
            setTimeout(() => {
                window.dispatchEvent(new CustomEvent('robocoders:open-robotics'));
            }, 200);
        } else {
            // First mount — flag picked up by onRegisterNewProject once GUI is ready
            window.__openblockRoboticsOnReady = true;
        }
        setBlocksReady(true);
        setMode('robotics');
    }, [blocksReady]);

    /* Called from ML Studio "Back" button — returns to the blocks/robotics editor.
       If the model the OPEN project depends on was deleted while in ML Studio, warn the
       user, keep the CORRECT block type via a metadata-only tombstone (so the palette
       isn't the misleading image-led union), and offer to import the model back. */
    const handleMLBack = useCallback(async () => {
        const deleted = deletedActiveModelRef.current;
        deletedActiveModelRef.current = null;

        const returnMode = preMlModeRef.current || 'blocks';
        preMlModeRef.current = 'blocks';

        if (deleted && deleted.projectId) {
            // Tombstone: keeps the project's correct block TYPE in the palette (no classifier,
            // so predictions return defaults). Safe here — the project is already loaded, so
            // narrowing the palette can't drop blocks (unlike during deserialization).
            window.__openblockMLModel = {
                projectId:      deleted.projectId,
                projectName:    deleted.name,
                type:           deleted.type,
                labels:         deleted.labels || [],
                trainingStatus: 'idle'
            };
        } else {
            // Normal Back — restore the model active before entering ML Studio.
            window.__openblockMLModel = savedMLModelRef.current;
        }
        savedMLModelRef.current = null;

        window.dispatchEvent(new CustomEvent('robocoders:ml-back'));
        setBlocksReady(true);
        setMode(returnMode);

        if (!(deleted && deleted.projectId)) return;

        // Warn the user that the model this project uses was deleted.
        const typeLabel = deleted.type === 'sounds' ? 'sound'
            : deleted.type === 'text' ? 'text' : 'image';
        const idx = await showAppDialog({
            type:    'warning',
            title:   'ML Model Deleted',
            message: `The ${typeLabel} ML model "${deleted.name || 'Unknown'}" used by this ` +
                'project was just deleted.',
            detail:  'Its ML blocks will stay in your project but won’t predict until you import ' +
                'the model again. Import the model file (.rcml) now, or continue without it.',
            buttons: ['Import Model…', 'Continue without ML'],
            defaultId: 0
        });
        if (idx !== 0) {
            // Continue without ML — REMOVE the ML category from the toolbox (so no new ML blocks
            // can be added) but KEEP the ML blocks already placed in the workspace. Clearing the
            // model ref + asking the blocks editor to unload the teachableMachine extension drops
            // its toolbox category; the placed blocks keep their Blockly definitions and stay
            // rendered. (On a later reopen the model is still missing, so the warning re-appears.)
            window.__openblockMLModel = null;
            try { window.require('electron').ipcRenderer.send('ml-clear-pending-project', null); } catch (_) { /* not in Electron */ }
            window.dispatchEvent(new CustomEvent('robocoders:ml-discard-category'));
            return;
        }

        // Import a .rcml; if it restores this project's model on disk, load the full classifier.
        try {
            const ipc = window.require('electron').ipcRenderer;
            const result = await ipc.invoke('ml-open-ob-file').catch(() => null);
            if (!result || result.canceled || result.error || !result.projectId) return;
            const id = result.projectId;
            const t  = deleted.type;
            const reloaded = t === 'sounds' ? loadAudioProject(id)
                : t === 'text' ? loadTextProject(id)
                : loadImageProject(id);
            // loadXxxProject() calls setActiveModel() internally, repopulating
            // window.__openblockMLModel with the live classifier and re-arming the
            // main-process pending id. Refresh the palette once it resolves.
            await reloaded;
            window.dispatchEvent(new CustomEvent('robocoders:ml-back'));
        } catch (_) { /* import/load failed — tombstone remains, predictions stay default */ }
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    /* Called from ML Studio "Use in Blocks" */
    const enterBlocksFromML = useCallback(async () => {
        cameFromHomeRef.current = false;
        savedMLModelRef.current = null;
        deletedActiveModelRef.current = null;

        const returnMode = preMlModeRef.current || 'blocks';
        preMlModeRef.current = 'blocks';

        if (!blocksReady) {
            // WrappedGui is mounting fresh — no existing project to check dirty state for.
            setBlocksReady(true);
            setMode(returnMode);
            window.__openblockMLPendingExport = window.__openblockMLModel || null;
            return;
        }

        if (newProjectCbRef.current) {
            // Await the callback: it will show a "save unsaved changes?" dialog if
            // the current project is dirty, then create the new project.
            // Returns false if the user cancelled — in that case stay in ML.
            const pendingModel = window.__openblockMLModel || null;
            const proceeded = await newProjectCbRef.current();
            if (!proceeded) return; // user cancelled — remain in ML environment

            // Switch to blocks AFTER the save dialog is resolved so that if the
            // user cancels, they stay in the ML view without any mode flicker.
            setBlocksReady(true);
            setMode(returnMode);
            // Arm pending export — PROJECT_LOADED in gui.jsx picks this up and fires
            // robocoders:ml-export-to-blocks once the blank project finishes loading.
            window.__openblockMLPendingExport = pendingModel;
        } else {
            setBlocksReady(true);
            setMode(returnMode);
            window.dispatchEvent(new CustomEvent('robocoders:ml-export-to-blocks'));
        }
    }, [blocksReady]);

    return (
        <>
            {mode === 'home' && (
                <HomeScreen onSelectMode={id => {
                    if (id === 'blocks') {
                        enterBlocks();
                    } else if (id === 'robotics') {
                        enterRobotics();
                    } else {
                        cameFromHomeRef.current = true;
                        preMlModeRef.current = 'blocks';
                        savedMLModelRef.current = window.__openblockMLModel || null;
                        setMode('ml');
                    }
                }} />
            )}
            {mode === 'ml' && (
                <MLStudioApp
                    onEnterBlocks={enterBlocksFromML}
                    onBack={handleMLBack}
                />
            )}

            {/*
              * WrappedGui: mounted once, never unmounted.
              * display:none hides it without destroying component state,
              * timers, or the WebGL canvas context.
              */}
            {blocksReady && (
                <div style={{
                    display: (mode === 'blocks' || mode === 'robotics') ? 'block' : 'none',
                    width: '100%',
                    height: '100%'
                }}>
                    <WrappedGui
                        onGoHome={() => setMode('home')}
                        onCancelLoader={() => {
                            // The project loader stalled — unmount the GUI so it
                            // remounts fresh next time the user enters Blocks.
                            // Just hiding it (display:none) leaves Redux in the stuck
                            // loading state; newProjectCbRef() cannot escape it.
                            setBlocksReady(false);
                            setMode('home');
                        }}
                        onRegisterNewProject={cb => {
                            newProjectCbRef.current = cb;
                            if (window.__openblockRoboticsOnReady) {
                                window.__openblockRoboticsOnReady = false;
                                setTimeout(() => {
                                    window.dispatchEvent(new CustomEvent('robocoders:open-robotics'));
                                }, 300);
                            }
                        }}
                    />
                </div>
            )}
        </>
    );
};

export default <AppRoot />;
