import React from 'react';

// Full-page loading splash — matches the static splash in index.html EXACTLY, so the loading
// window shows a single, consistent "RoboCoders Studio is loading…" screen (no switch from the
// static splash to a different visual once React mounts). Inline styles mirror index.html's <style>.
const WRAP_STYLE = {
    margin: 0,
    position: 'absolute',
    top: '50%',
    left: '50%',
    transform: 'translate(-50%, -50%)',
    textAlign: 'center',
    fontFamily: '"Helvetica Neue", Helvetica, Arial, sans-serif'
};

const TITLE_STYLE = {
    color: 'white',
    fontSize: 'xx-large',
    fontWeight: 'bolder',
    margin: 0
};

const TAGLINE_STYLE = {
    color: 'rgba(255, 255, 255, 0.92)',
    fontSize: '1.1rem',
    fontWeight: 600,
    letterSpacing: '0.4px',
    margin: '16px 0 0'
};

const BRAND_STYLE = {
    color: '#FFC02E',
    fontWeight: 700
};

const LoadingElement = () => (
    <div style={WRAP_STYLE}>
        <p style={TITLE_STYLE}>{'RoboCoders Studio is loading...'}</p>
        <p style={TAGLINE_STYLE}>
            {'Code • Build • Innovate with '}
            <span style={BRAND_STYLE}>{'RoboCoders Studio'}</span>
        </p>
    </div>
);

export default <LoadingElement />;
