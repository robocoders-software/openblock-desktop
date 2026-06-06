import React, {useState, useEffect, useCallback} from 'react';
import PropTypes from 'prop-types';
import {ipcRenderer} from 'electron';

import logo from '../icon/OpenBlockDesktop.png';
import styles from './activation-screen.css';

const ActivationScreen = ({onActivated, blockedReason}) => {
    const [machineId, setMachineId] = useState('Loading…');
    const [key, setKey] = useState('');
    const [loading, setLoading] = useState(false);
    const [message, setMessage] = useState(null); // { text, type: 'error'|'success' }
    const [copied, setCopied] = useState(false);

    useEffect(() => {
        ipcRenderer.invoke('get-machine-id').then(id => {
            setMachineId(id || 'Unavailable');
        });
    }, []);

    const handleCopy = useCallback(() => {
        navigator.clipboard.writeText(machineId).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    }, [machineId]);

    const handleKeyChange = useCallback(e => {
        // Auto-uppercase and allow only valid Base32 chars + dashes
        const raw = e.target.value.toUpperCase().replace(/[^A-Z2-7\-]/g, '');
        setKey(raw);
        setMessage(null);
    }, []);

    const handleActivate = useCallback(async () => {
        const trimmed = key.trim();
        if (!trimmed) {
            setMessage({text: 'Please enter your activation key.', type: 'error'});
            return;
        }
        setLoading(true);
        setMessage(null);
        try {
            const result = await ipcRenderer.invoke('activate-license', trimmed);
            if (result.valid) {
                setMessage({text: 'Activated successfully! Opening the app…', type: 'success'});
                setTimeout(() => onActivated(), 1200);
            } else {
                setMessage({text: result.reason || 'Activation failed.', type: 'error'});
                setLoading(false);
            }
        } catch (err) {
            setMessage({text: 'Unexpected error — please try again.', type: 'error'});
            setLoading(false);
        }
    }, [key, onActivated]);

    const handleKeyDown = useCallback(e => {
        if (e.key === 'Enter' && !loading) handleActivate();
    }, [loading, handleActivate]);

    return (
        <div className={styles.wrapper}>
            <div className={styles.card}>
                <div className={styles.logo}>
                    <img
                        src={logo}
                        alt="RoboCoders Studio"
                    />
                </div>

                <h1 className={styles.heading}>Activate RoboCoders Studio</h1>

                {blockedReason && (
                    <div className={styles.blockedBanner}>
                        <strong>License issue detected</strong>
                        {blockedReason}
                    </div>
                )}

                <p className={styles.subtitle}>
                    Share your Machine ID with your administrator to receive an activation key.
                </p>

                <div className={styles.fieldLabel}>Your Machine ID</div>
                <div className={styles.machineIdBox}>{machineId}</div>
                <div className={styles.copyHint}>
                    <button
                        onClick={handleCopy}
                        tabIndex={-1}
                    >
                        {copied ? '✓ Copied' : 'Copy to clipboard'}
                    </button>
                </div>

                <div className={styles.fieldLabel}>Activation Key (32 characters)</div>
                <input
                    className={styles.keyInput}
                    type="text"
                    value={key}
                    onChange={handleKeyChange}
                    onKeyDown={handleKeyDown}
                    placeholder="XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XXXXX-XX"
                    autoComplete="off"
                    spellCheck="false"
                    disabled={loading}
                />

                <button
                    className={styles.activateBtn}
                    onClick={handleActivate}
                    disabled={loading}
                >
                    {loading && <span className={styles.btnSpinner} />}
                    {loading ? 'Verifying…' : 'Activate'}
                </button>

                {message && (
                    <div className={`${styles.message} ${message.type === 'error' ? styles.messageError : styles.messageSuccess}`}>
                        {message.text}
                    </div>
                )}
            </div>
        </div>
    );
};

ActivationScreen.propTypes = {
    onActivated: PropTypes.func.isRequired,
    blockedReason: PropTypes.string
};

ActivationScreen.defaultProps = {
    blockedReason: null
};

export default ActivationScreen;
