import React, {useState, useRef, useCallback, useEffect} from 'react';
import {compose} from 'redux';
import GUI from 'openblock-gui/src/index';
import AppStateHOC from 'openblock-gui/src/lib/app-state-hoc.jsx';
import MLStudioApp from 'openblock-ml-studio';

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
    const [mode, setMode] = useState('home'); // 'home' | 'blocks' | 'ml'
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

    /* Listen for "Open ML Env" from within the blocks editor */
    useEffect(() => {
        const handler = () => {
            cameFromHomeRef.current = false; // arrived from blocks editor, not home screen
            savedMLModelRef.current = window.__openblockMLModel || null;
            setMode('ml');
        };
        window.addEventListener('robocoders:open-ml', handler);
        return () => window.removeEventListener('robocoders:open-ml', handler);
    }, []);

    /* If the user deletes the model that was active in the blocks editor, don't restore it on Back */
    useEffect(() => {
        const handler = e => {
            if (savedMLModelRef.current &&
                savedMLModelRef.current.projectId === e.detail.projectId) {
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
            // Already initialized — just reset to a blank project, no remount
            newProjectCbRef.current();
        }
        setBlocksReady(true);
        setMode('blocks');
    }, [blocksReady]);

    /* Called from ML Studio "Use in Blocks" */
    const enterBlocksFromML = useCallback(() => {
        const shouldCreateNew = cameFromHomeRef.current;
        cameFromHomeRef.current = false;
        savedMLModelRef.current = null; // export is intentional — don't restore old model

        setBlocksReady(true);
        setMode('blocks');

        if (!blocksReady) {
            // WrappedGui is mounting fresh and will load a blank project on mount.
            // Pre-arm the pending export so the PROJECT_LOADED handler in gui.jsx
            // picks it up and fires robocoders:ml-export-to-blocks once the blank
            // project finishes loading — same mechanism as the shouldCreateNew path below.
            window.__openblockMLPendingExport = window.__openblockMLModel || null;
            return;
        }

        if (shouldCreateNew && newProjectCbRef.current) {
            // User came via home screen → ML → export: create a blank project first.
            // We signal gui.jsx's PROJECT_LOADED handler to trigger the export once the
            // blank project is fully loaded — avoids the race where PROJECT_LOADED fires
            // after the export event and clears the model, compressing/breaking the blocks.
            window.__openblockMLPendingExport = window.__openblockMLModel || null;
            newProjectCbRef.current(); // resets project, clears __openblockMLModel, unloads extension
            // gui.jsx's PROJECT_LOADED handler picks up __openblockMLPendingExport and
            // restores the model + fires robocoders:ml-export-to-blocks from there.
        } else {
            // User came via "Open ML Env" from an existing project — export into it.
            window.dispatchEvent(new CustomEvent('robocoders:ml-export-to-blocks'));
        }
    }, [blocksReady]);

    return (
        <>
            {mode === 'home' && (
                <HomeScreen onSelectMode={id => {
                    if (id === 'blocks') {
                        enterBlocks();
                    } else {
                        cameFromHomeRef.current = true;
                        savedMLModelRef.current = window.__openblockMLModel || null;
                        setMode('ml');
                    }
                }} />
            )}
            {mode === 'ml' && (
                <MLStudioApp
                    onEnterBlocks={enterBlocksFromML}
                    onBack={() => {
                        // Restore the model that was active before entering ML Studio so that
                        // training a different model without exporting doesn't silently change
                        // the blocks editor's active model.
                        window.__openblockMLModel = savedMLModelRef.current;
                        savedMLModelRef.current = null;
                        // Signal gui.jsx to unload/refresh teachableMachine appropriately
                        window.dispatchEvent(new CustomEvent('robocoders:ml-back'));
                        // Always go to blocks editor:
                        // - blocksReady=false → first time, mounts fresh → blank project
                        // - blocksReady=true  → already mounted → existing project intact
                        setBlocksReady(true);
                        setMode('blocks');
                    }}
                />
            )}

            {/*
              * WrappedGui: mounted once, never unmounted.
              * display:none hides it without destroying component state,
              * timers, or the WebGL canvas context.
              */}
            {blocksReady && (
                <div style={{
                    display: mode === 'blocks' ? 'block' : 'none',
                    width: '100%',
                    height: '100%'
                }}>
                    <WrappedGui
                        onGoHome={() => setMode('home')}
                        onRegisterNewProject={cb => { newProjectCbRef.current = cb; }}
                    />
                </div>
            )}
        </>
    );
};

export default <AppRoot />;
