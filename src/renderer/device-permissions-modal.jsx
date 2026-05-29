import {ipcRenderer} from 'electron';
import React, {useEffect, useState, useCallback, useRef} from 'react';
import PropTypes from 'prop-types';
import styles from './device-permissions-modal.css';

const STATUS_LABEL = {
    granted: 'Allowed',
    denied: 'Denied',
    'not-determined': 'Not set'
};

const PermissionRow = ({icon, label, status, onReset}) => (
    <div className={styles.row}>
        <span className={styles.rowIcon}>{icon}</span>
        <span className={styles.rowLabel}>{label}</span>
        <span className={`${styles.badge} ${styles[`badge_${status}`]}`}>
            {STATUS_LABEL[status] || status}
        </span>
        <button
            className={styles.resetBtn}
            disabled={status === 'not-determined'}
            onClick={onReset}
            title="Clear stored choice — you will be asked again next time"
        >
            Reset
        </button>
    </div>
);

PermissionRow.propTypes = {
    icon: PropTypes.string.isRequired,
    label: PropTypes.string.isRequired,
    status: PropTypes.string.isRequired,
    onReset: PropTypes.func.isRequired
};

const DevicePermissionsModal = ({onClose}) => {
    const [cameraStatus, setCameraStatus] = useState('not-determined');
    const [micStatus, setMicStatus] = useState('not-determined');
    const [refreshing, setRefreshing] = useState(false);
    const mountedRef = useRef(true);
    useEffect(() => () => { mountedRef.current = false; }, []);

    const refresh = useCallback(async () => {
        const [cam, mic] = await Promise.all([
            ipcRenderer.invoke('get-media-permission', 'camera'),
            ipcRenderer.invoke('get-media-permission', 'microphone')
        ]);
        if (!mountedRef.current) return;
        setCameraStatus(cam || 'not-determined');
        setMicStatus(mic || 'not-determined');
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    const handleResetCamera = useCallback(async () => {
        await ipcRenderer.invoke('reset-media-permission', 'camera');
        refresh();
    }, [refresh]);

    const handleResetMic = useCallback(async () => {
        await ipcRenderer.invoke('reset-media-permission', 'microphone');
        refresh();
    }, [refresh]);

    const handleResetAll = useCallback(async () => {
        await ipcRenderer.invoke('reset-all-media-permissions');
        refresh();
    }, [refresh]);

    /* Refresh All: clears stored choices + Chromium session, then immediately
       re-probes both devices so permission dialogs appear right now and device
       labels populate without needing to open a training page first. */
    const handleRefreshAll = useCallback(async () => {
        if (refreshing) return;
        setRefreshing(true);
        try {
            await ipcRenderer.invoke('reset-all-media-permissions');
            // Probe both devices — triggers permission dialogs and unlocks device labels
            const stream = await navigator.mediaDevices
                .getUserMedia({video: true, audio: true})
                .catch(() => null);
            if (stream) stream.getTracks().forEach(t => t.stop());
        } catch (_) { /* ignore */ }
        if (mountedRef.current) {
            setRefreshing(false);
            refresh();
        }
    }, [refresh, refreshing]);

    return (
        <div
            className={styles.overlay}
            onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}
        >
            <div className={styles.modal}>
                <div className={styles.header}>
                    <span className={styles.title}>Device Permissions</span>
                    <button className={styles.closeBtn} onClick={onClose}>✕</button>
                </div>
                <div className={styles.body}>
                    <p className={styles.description}>
                        {'Refresh All re-asks for permission right now and populates real device names. ' +
                         'Reset clears a stored choice so the dialog appears on next device use.'}
                    </p>
                    <PermissionRow
                        icon="📷"
                        label="Camera"
                        status={cameraStatus}
                        onReset={handleResetCamera}
                    />
                    <PermissionRow
                        icon="🎤"
                        label="Microphone"
                        status={micStatus}
                        onReset={handleResetMic}
                    />
                </div>
                <div className={styles.footer}>
                    <button
                        className={styles.refreshAllBtn}
                        disabled={refreshing}
                        onClick={handleRefreshAll}
                        title="Clear all choices and ask for permission right now"
                    >
                        {refreshing ? 'Requesting…' : 'Refresh All Permissions'}
                    </button>
                    <button
                        className={styles.resetAllBtn}
                        disabled={cameraStatus === 'not-determined' && micStatus === 'not-determined'}
                        onClick={handleResetAll}
                    >
                        Reset All
                    </button>
                    <button className={styles.doneBtn} onClick={onClose}>Done</button>
                </div>
            </div>
        </div>
    );
};

DevicePermissionsModal.propTypes = {
    onClose: PropTypes.func.isRequired
};

export default DevicePermissionsModal;
