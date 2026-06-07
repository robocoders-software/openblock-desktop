import React from 'react';
import {productName} from '../../package.json';

import logo from '../icon/OpenBlockLoading.svg';
import styles from './loading.css';

const LoadingElement = () => (
    <div className={styles.loadingBox}>
        <div>
            <img
                alt={`${productName} loading icon`}
                src={logo}
                className={styles.loadingLogo}
            />
        </div>
        <p className={styles.loadingTagline}>
            {'Code • Build • Innovate'}
            <br />
            {'with '}
            <span className={styles.loadingBrand}>{'RoboCoders Studio'}</span>
        </p>
    </div>
);

export default <LoadingElement />;
