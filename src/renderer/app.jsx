import React, {useState, useRef, useCallback} from 'react';
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

    /* Called whenever the user selects "Blocks" from home or ML studio */
    const enterBlocks = useCallback(() => {
        if (blocksReady && newProjectCbRef.current) {
            // Already initialized — just reset to a blank project, no remount
            newProjectCbRef.current();
        }
        setBlocksReady(true);
        setMode('blocks');
    }, [blocksReady]);

    return (
        <>
            {mode === 'home' && (
                <HomeScreen onSelectMode={id => (id === 'blocks' ? enterBlocks() : setMode('ml'))} />
            )}
            {mode === 'ml' && (
                <MLStudioApp
                    onEnterBlocks={enterBlocks}
                    onBack={() => {
                        // Signal gui.jsx to unload teachableMachine if no model was exported
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
