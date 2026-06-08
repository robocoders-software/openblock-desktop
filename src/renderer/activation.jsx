import React, {useState, useEffect, useCallback} from 'react';
import {ipcRenderer} from 'electron';
import {productName, version} from '../../package.json';

import logo from '../icon/logo-OpenBlockcc.svg';
import styles from './activation.css';

// Turn a raw checkStartup reason into a friendly title/body + whether a "Try Again"
// (re-check) makes sense (e.g. after the user corrects their system clock).
const mapReason = reason => {
    if (!reason) return null;
    const r = reason.toLowerCase();
    if (r.includes('clock')) {
        return {
            title: 'System clock change detected',
            body: 'Your device’s date & time appear to have been changed. Set the correct ' +
                'date & time, then click “Try Again”. Your existing license will resume ' +
                'automatically — you do not need a new key.',
            retry: true
        };
    }
    if (r.includes('expired')) {
        return {
            title: 'License expired',
            body: `${reason}. Enter a new activation key below to continue.`,
            retry: false
        };
    }
    if (r.includes('not valid until')) {
        return {
            title: 'License not active yet',
            body: `${reason}. If your device date is wrong, correct it and click “Try Again”.`,
            retry: true
        };
    }
    return {
        title: 'License problem',
        body: `${reason}. Please enter a valid activation key for this device.`,
        retry: false
    };
};

const ActivationApp = () => {
    const [machineId, setMachineId] = useState('…');
    const [key, setKey] = useState('');
    const [status, setStatus] = useState('idle'); // idle | working | success | error
    const [error, setError] = useState('');
    const [copied, setCopied] = useState(false);
    const [warning, setWarning] = useState(null);
    const [rechecking, setRechecking] = useState(false);
    const [successText, setSuccessText] = useState('Activated successfully');

    useEffect(() => {
        ipcRenderer.invoke('license:get-machine-id')
            .then(id => setMachineId(id || 'unavailable'))
            .catch(() => setMachineId('unavailable'));
        // Why is this screen showing? (clock rollback / expired / etc.)
        ipcRenderer.invoke('license:get-status')
            .then(s => {
                if (s && s.activated && s.reason) setWarning(mapReason(s.reason));
            })
            .catch(() => {});
    }, []);

    const copyMachineId = useCallback(() => {
        navigator.clipboard.writeText(machineId)
            .then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1800);
            })
            .catch(() => {});
    }, [machineId]);

    const activate = useCallback(async () => {
        const k = key.trim();
        if (!k) {
            setError('Please enter your activation key.');
            setStatus('error');
            return;
        }
        setStatus('working');
        setError('');
        try {
            const r = await ipcRenderer.invoke('license:activate', k);
            if (r && r.valid) {
                setSuccessText('Activated successfully');
                setStatus('success'); // main relaunches the app shortly after
            } else {
                setError((r && r.reason) || 'Activation failed.');
                setStatus('error');
            }
        } catch (e) {
            setError(`Activation error: ${e && e.message ? e.message : 'unknown'}`);
            setStatus('error');
        }
    }, [key]);

    const tryAgain = useCallback(async () => {
        setRechecking(true);
        try {
            const r = await ipcRenderer.invoke('license:recheck');
            if (r && r.ok) {
                setSuccessText('License verified');
                setStatus('success'); // main relaunches
                return;
            }
            setWarning(mapReason((r && r.reason) || 'Still blocked'));
        } catch (_) { /* ignore */ }
        setRechecking(false);
    }, []);

    const onKeyDown = useCallback(e => {
        if (e.key === 'Enter') activate();
    }, [activate]);

    const handleKeyChange = useCallback(e => setKey(e.target.value), []);

    return (
        <div className={styles.wrap}>
            <div className={styles.card}>
                <img
                    className={styles.logo}
                    src={logo}
                    alt={productName}
                />
                <p className={styles.tagline}>
                    {'Code • Build • Innovate with '}
                    <span className={styles.brand}>{'RoboCoders Studio'}</span>
                </p>

                {status === 'success' ? (
                    <div className={styles.successBox}>
                        <div className={styles.successTick}>{'✓'}</div>
                        <p className={styles.successText}>{successText}</p>
                        <p className={styles.successSub}>{'Restarting RoboCoders Studio…'}</p>
                    </div>
                ) : (
                    <React.Fragment>
                        {warning && (
                            <div className={styles.warnBox}>
                                <div className={styles.warnTitle}>{`⚠ ${warning.title}`}</div>
                                <div className={styles.warnBody}>{warning.body}</div>
                                {warning.retry && (
                                    <button
                                        className={styles.retryBtn}
                                        onClick={tryAgain}
                                        disabled={rechecking}
                                    >
                                        {rechecking ? 'Checking…' : 'Try Again'}
                                    </button>
                                )}
                            </div>
                        )}

                        <div className={styles.field}>
                            <label className={styles.label}>{'Your Machine ID'}</label>
                            <div className={styles.machineRow}>
                                <code className={styles.machineId}>{machineId}</code>
                                <button
                                    className={styles.copyBtn}
                                    onClick={copyMachineId}
                                >
                                    {copied ? '✓ Copied' : 'Copy'}
                                </button>
                            </div>
                            <span className={styles.hint}>
                                {'Send this Machine ID to your provider to receive an activation key.'}
                            </span>
                        </div>

                        <div className={styles.field}>
                            <label className={styles.label}>{'Activation Key'}</label>
                            <input
                                className={styles.input}
                                type="text"
                                value={key}
                                onChange={handleKeyChange}
                                onKeyDown={onKeyDown}
                                placeholder="XXXXXXX-XXXXXXX-XXXXXXX"
                                spellCheck={false}
                                autoFocus
                            />
                        </div>

                        {status === 'error' && error && (
                            <div className={styles.errorBox}>{error}</div>
                        )}

                        <button
                            className={styles.activateBtn}
                            onClick={activate}
                            disabled={status === 'working'}
                        >
                            {status === 'working' ? 'Activating…' : 'Activate'}
                        </button>
                    </React.Fragment>
                )}

                <div className={styles.footer}>{`Version ${version} • © YugMinds Private Limited`}</div>
            </div>
        </div>
    );
};

export default <ActivationApp />;
