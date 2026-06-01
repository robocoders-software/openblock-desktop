import React from 'react';
import {productName, version} from '../../package.json';

import logo from '../icon/OpenBlockDesktop.svg';
import styles from './about.css';

const AboutElement = () => (
    <div className={styles.aboutBox}>
        <div><img
            alt={`${productName} icon`}
            src={logo}
            className={styles.aboutLogo}
        /></div>
        <div className={styles.aboutText}>
            <h2>{productName}</h2>
            <div>{'Version '}{version}</div>
            <div className={styles.aboutCopyright}>{'© YugMinds Private Limited'}</div>
        </div>
    </div>
);

export default <AboutElement />;
