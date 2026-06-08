import React, {useState, useEffect} from 'react';
import PropTypes from 'prop-types';
import {ipcRenderer} from 'electron';
import {productName} from '../../package.json';

import logo from '../icon/logo-OpenBlockcc.svg';
import styles from './license-details.css';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// iso is "YYYY-MM-DD" — format without timezone shifting
const fmtDate = iso => {
    if (!iso) return '—';
    const [y, m, d] = iso.split('-').map(Number);
    if (!y) return iso;
    return `${MONTHS[(m || 1) - 1]} ${d}, ${y}`;
};

const Row = ({label, value, mono}) => (
    <div className={styles.row}>
        <span className={styles.rowLabel}>{label}</span>
        <span className={`${styles.rowValue} ${mono ? styles.mono : ''}`}>
            {value}
        </span>
    </div>
);
Row.propTypes = {
    label: PropTypes.string,
    value: PropTypes.string,
    mono: PropTypes.bool
};

const LicenseDetails = () => {
    const [info, setInfo] = useState(null);
    const [loaded, setLoaded] = useState(false);

    useEffect(() => {
        ipcRenderer.invoke('license:get-details')
            .then(r => setInfo(r))
            .catch(() => setInfo({valid: false}))
            .finally(() => setLoaded(true));
    }, []);

    const active = info && info.valid;
    const expSoon = active && info.daysRemaining <= 14;

    let body;
    if (!loaded) {
        body = <p className={styles.loading}>{'Loading…'}</p>;
    } else if (active) {
        body = (
            <React.Fragment>
                <div className={styles.statusRow}>
                    <span className={`${styles.badge} ${expSoon ? styles.badgeWarn : styles.badgeOk}`}>
                        {expSoon ? '● Expiring soon' : '● Active'}
                    </span>
                    <span className={styles.daysLeft}>
                        {`${info.daysRemaining} day${info.daysRemaining === 1 ? '' : 's'} remaining`}
                    </span>
                </div>
                <div className={styles.rows}>
                    <Row
                        label="Status"
                        value="Activated"
                    />
                    <Row
                        label="Valid from"
                        value={fmtDate(info.startDate)}
                    />
                    <Row
                        label="Valid until"
                        value={fmtDate(info.expiryDate)}
                    />
                    <Row
                        label="Machine ID"
                        value={info.machineId}
                        mono
                    />
                </div>
            </React.Fragment>
        );
    } else {
        body = <div className={styles.notActive}>{'No active license found.'}</div>;
    }

    return (
        <div className={styles.wrap}>
            <div className={styles.head}>
                <img
                    className={styles.logo}
                    src={logo}
                    alt={productName}
                />
                <h1 className={styles.title}>{'License'}</h1>
            </div>

            {body}

            <div className={styles.footer}>
                {`This device is licensed to run ${productName}.`}
            </div>
        </div>
    );
};

export default <LicenseDetails />;
