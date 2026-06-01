import React, {useState} from 'react';
import PropTypes from 'prop-types';
import styles from './home-screen.css';

/* ─── Inline SVG icons ───────────────────────────── */
const BlocksIcon = () => (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4"  y="28" width="24" height="16" rx="4" fill="#FF8C42"/>
        <rect x="4"  y="28" width="10" height="6"  rx="2" fill="#FF6B00"/>
        <rect x="36" y="16" width="24" height="16" rx="4" fill="#004AAD"/>
        <rect x="36" y="16" width="10" height="6"  rx="2" fill="#003A8C"/>
        <rect x="20" y="40" width="24" height="16" rx="4" fill="#003A8C"/>
        <rect x="20" y="40" width="10" height="6"  rx="2" fill="#002D6E"/>
    </svg>
);

const AIIcon = () => (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="24" cy="28" rx="16" ry="18" fill="#004AAD" opacity="0.85"/>
        <ellipse cx="40" cy="28" rx="16" ry="18" fill="#003A8C" opacity="0.85"/>
        <ellipse cx="32" cy="28" rx="8"  ry="18" fill="#4D8FD6"/>
        <circle cx="18" cy="22" r="3" fill="white" opacity="0.9"/>
        <circle cx="26" cy="32" r="3" fill="white" opacity="0.9"/>
        <circle cx="38" cy="22" r="3" fill="white" opacity="0.9"/>
        <circle cx="46" cy="32" r="3" fill="white" opacity="0.9"/>
        <circle cx="32" cy="18" r="3" fill="white" opacity="0.9"/>
        <line x1="18" y1="22" x2="26" y2="32" stroke="white" strokeWidth="1.5" opacity="0.55"/>
        <line x1="26" y1="32" x2="38" y2="22" stroke="white" strokeWidth="1.5" opacity="0.55"/>
        <line x1="38" y1="22" x2="46" y2="32" stroke="white" strokeWidth="1.5" opacity="0.55"/>
        <line x1="18" y1="22" x2="32" y2="18" stroke="white" strokeWidth="1.5" opacity="0.55"/>
        <line x1="32" y1="18" x2="46" y2="32" stroke="white" strokeWidth="1.5" opacity="0.55"/>
        <line x1="28" y1="46" x2="36" y2="46" stroke="#FF8C1A" strokeWidth="2" strokeLinecap="round"/>
        <line x1="22" y1="50" x2="42" y2="50" stroke="#FF8C1A" strokeWidth="2" strokeLinecap="round"/>
        <line x1="28" y1="46" x2="22" y2="50" stroke="#FF8C1A" strokeWidth="2" strokeLinecap="round"/>
        <line x1="36" y1="46" x2="42" y2="50" stroke="#FF8C1A" strokeWidth="2" strokeLinecap="round"/>
    </svg>
);

const RoboticsIcon = () => (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        {/* Robot head */}
        <rect x="18" y="10" width="28" height="22" rx="5" fill="#004AAD"/>
        {/* Antenna */}
        <line x1="32" y1="10" x2="32" y2="4" stroke="#003A8C" strokeWidth="2.5" strokeLinecap="round"/>
        <circle cx="32" cy="3" r="2.5" fill="#FF8C42"/>
        {/* Eyes */}
        <rect x="23" y="17" width="7" height="5" rx="2" fill="white"/>
        <rect x="34" y="17" width="7" height="5" rx="2" fill="white"/>
        <circle cx="26.5" cy="19.5" r="2" fill="#004AAD"/>
        <circle cx="37.5" cy="19.5" r="2" fill="#004AAD"/>
        {/* Mouth */}
        <rect x="25" y="26" width="14" height="3" rx="1.5" fill="#4D8FD6"/>
        {/* Body */}
        <rect x="20" y="34" width="24" height="18" rx="4" fill="#003A8C"/>
        {/* Chest panel */}
        <rect x="25" y="38" width="14" height="9" rx="2" fill="#4D8FD6" opacity="0.5"/>
        <circle cx="29" cy="42.5" r="1.5" fill="#FF8C42"/>
        <circle cx="35" cy="42.5" r="1.5" fill="#0FBD8C"/>
        {/* Arms */}
        <rect x="8"  y="35" width="10" height="5" rx="2.5" fill="#004AAD"/>
        <rect x="46" y="35" width="10" height="5" rx="2.5" fill="#004AAD"/>
        {/* Legs */}
        <rect x="22" y="53" width="8" height="7" rx="2" fill="#003A8C"/>
        <rect x="34" y="53" width="8" height="7" rx="2" fill="#003A8C"/>
    </svg>
);

/* ─── Card definitions ───────────────────────────── */
const TOP_SECTIONS = [
    {
        title: 'Block Coding',
        cards: [{
            id: 'blocks',
            title: 'Blocks',
            description: 'Code with playful puzzle-shaped blocks',
            age: 'Ages 7+',
            icon: <BlocksIcon />
        }]
    },
    {
        title: 'Robotics',
        cards: [{
            id: 'robotics',
            title: 'Robotics',
            description: 'Program and control real robots & microcontrollers — Arduino, Raspberry Pi, ESP32 and more',
            age: 'Ages 10+',
            icon: <RoboticsIcon />
        }]
    }
];

const BOTTOM_SECTIONS = [
    {
        title: 'AI & Machine Learning',
        cards: [{
            id: 'ml',
            title: 'AI & Machine Learning',
            description: 'Train custom AI models to recognise images, text & sounds — then use them in your projects',
            age: 'Ages 10+',
            icon: <AIIcon />
        }]
    }
];

/* ─── ModeCard ───────────────────────────────────── */
const ModeCard = ({mode, onClick, isLoading, isDisabled}) => (
    <div
        className={[
            styles.modeCard,
            isLoading  ? styles.modeCardLoading  : '',
            isDisabled ? styles.modeCardDisabled : ''
        ].join(' ')}
        onClick={() => !isDisabled && !isLoading && onClick(mode.id)}
        role="button"
        tabIndex={isDisabled ? -1 : 0}
        onKeyDown={e => e.key === 'Enter' && !isDisabled && !isLoading && onClick(mode.id)}
        aria-disabled={isDisabled || isLoading}
    >
        {mode.age && <span className={styles.ageBadge}>{mode.age}</span>}
        <div className={styles.modeIcon}>{mode.icon}</div>
        <p className={styles.modeTitle}>{mode.title}</p>
        <p className={styles.modeDescription}>{mode.description}</p>

        {isLoading && (
            <div className={styles.loadingOverlay}>
                <div className={styles.spinner} />
                <span className={styles.loadingLabel}>Loading…</span>
            </div>
        )}
    </div>
);

ModeCard.propTypes = {
    mode: PropTypes.shape({
        id: PropTypes.string.isRequired,
        title: PropTypes.string.isRequired,
        description: PropTypes.string.isRequired,
        age: PropTypes.string,
        icon: PropTypes.node
    }).isRequired,
    onClick: PropTypes.func.isRequired,
    isLoading: PropTypes.bool,
    isDisabled: PropTypes.bool
};

ModeCard.defaultProps = {
    isLoading: false,
    isDisabled: false
};

/* ─── HomeScreen ─────────────────────────────────── */
const HomeScreen = ({onSelectMode}) => {
    const [loadingId, setLoadingId] = useState(null);

    const handleSelect = id => {
        if (loadingId) return;
        setLoadingId(id);
        // Two-frame delay: first frame paints the spinner overlay,
        // second frame lets the browser composite it before the heavy
        // navigation/initialization work starts on the main thread.
        // setTimeout fallback ensures navigation happens even if RAF is
        // throttled (e.g. window briefly backgrounded during the click).
        let navigated = false;
        const navigate = () => { if (!navigated) { navigated = true; onSelectMode(id); } };
        requestAnimationFrame(() => requestAnimationFrame(navigate));
        setTimeout(navigate, 300);
    };

    return (
        <div className={styles.homeWrapper}>
            <div className={styles.card}>
                <h1 className={styles.heading}>What would you like to do?</h1>

                {/* Block Coding + Robotics side by side */}
                <div className={styles.topRow}>
                    {TOP_SECTIONS.map(({title, cards}) => (
                        <div key={title} className={styles.section}>
                            <h2 className={styles.sectionTitle}>{title}</h2>
                            <div className={styles.modeGrid}>
                                {cards.map(m => (
                                    <ModeCard
                                        key={m.id}
                                        mode={m}
                                        onClick={handleSelect}
                                        isLoading={loadingId === m.id}
                                        isDisabled={loadingId !== null && loadingId !== m.id}
                                    />
                                ))}
                            </div>
                        </div>
                    ))}
                </div>

                {/* ML below, full width */}
                {BOTTOM_SECTIONS.map(({title, cards}) => (
                    <div key={title} className={styles.section}>
                        <h2 className={styles.sectionTitle}>{title}</h2>
                        <div className={styles.modeGrid}>
                            {cards.map(m => (
                                <ModeCard
                                    key={m.id}
                                    mode={m}
                                    onClick={handleSelect}
                                    isLoading={loadingId === m.id}
                                    isDisabled={loadingId !== null && loadingId !== m.id}
                                />
                            ))}
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};

HomeScreen.propTypes = {
    onSelectMode: PropTypes.func.isRequired
};

export default HomeScreen;
