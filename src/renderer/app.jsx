import React, {useState} from 'react';
import {compose} from 'redux';
import GUI from 'openblock-gui/src/index';
import AppStateHOC from 'openblock-gui/src/lib/app-state-hoc.jsx';
import {HomeScreen} from 'openblock-ml-studio';

import ScratchDesktopAppStateHOC from './ScratchDesktopAppStateHOC.jsx';
import ScratchDesktopGUIHOC from './ScratchDesktopGUIHOC.jsx';
import styles from './app.css';

/* ── The full blocks GUI (unchanged from before) ── */
const WrappedGui = compose(
    ScratchDesktopAppStateHOC,
    AppStateHOC,
    ScratchDesktopGUIHOC
)(GUI);

const appTarget = document.getElementById('app');
appTarget.className = styles.app || 'app';
GUI.setAppElement(appTarget);

/* ── Root: show HomeScreen first, switch to blocks on demand ──
   HomeScreen handles the entire AI & ML / ML Studio flow internally.
   It only calls onSelectMode('blocks') when the user wants to code with blocks
   (either by clicking the "Blocks" card or "Use in Blocks" from ML Studio).
── */
const AppRoot = () => {
    const [mode, setMode] = useState('home'); // 'home' | 'blocks'

    if (mode === 'blocks') {
        return <WrappedGui />;
    }

    return (
        <HomeScreen onSelectMode={selectedMode => {
            if (selectedMode === 'blocks') setMode('blocks');
        }} />
    );
};

export default <AppRoot />;
