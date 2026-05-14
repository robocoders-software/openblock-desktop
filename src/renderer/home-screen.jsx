import React from 'react';
import PropTypes from 'prop-types';
import styles from './home-screen.css';

/* ─── Inline SVG icons ───────────────────────────── */
const BlocksIcon = () => (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <rect x="4"  y="28" width="24" height="16" rx="4" fill="#FF8C42"/>
        <rect x="4"  y="28" width="10" height="6"  rx="2" fill="#FF6B00"/>
        <rect x="36" y="16" width="24" height="16" rx="4" fill="#9966FF"/>
        <rect x="36" y="16" width="10" height="6"  rx="2" fill="#7040C0"/>
        <rect x="20" y="40" width="24" height="16" rx="4" fill="#774DCB"/>
        <rect x="20" y="40" width="10" height="6"  rx="2" fill="#5C3399"/>
    </svg>
);

const AIIcon = () => (
    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="24" cy="28" rx="16" ry="18" fill="#9966FF" opacity="0.85"/>
        <ellipse cx="40" cy="28" rx="16" ry="18" fill="#774DCB" opacity="0.85"/>
        <ellipse cx="32" cy="28" rx="8"  ry="18" fill="#BB88FF"/>
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

/* ─── Card definitions ───────────────────────────── */
const SECTIONS = [
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
        title: 'AI & Machine Learning',
        cards: [{
            id: 'ml',
            title: 'AI & Machine Learning',
            description: 'Train custom AI models to recognise images, text & numbers — then use them in your projects',
            age: 'Ages 10+',
            icon: <AIIcon />
        }]
    }
];

/* ─── ModeCard ───────────────────────────────────── */
const ModeCard = ({mode, onClick}) => (
    <div
        className={styles.modeCard}
        onClick={() => onClick(mode.id)}
        role="button"
        tabIndex={0}
        onKeyDown={e => e.key === 'Enter' && onClick(mode.id)}
    >
        {mode.age && <span className={styles.ageBadge}>{mode.age}</span>}
        <div className={styles.modeIcon}>{mode.icon}</div>
        <p className={styles.modeTitle}>{mode.title}</p>
        <p className={styles.modeDescription}>{mode.description}</p>
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
    onClick: PropTypes.func.isRequired
};

/* ─── HomeScreen ─────────────────────────────────── */
const HomeScreen = ({onSelectMode}) => (
    <div className={styles.homeWrapper}>
        <div className={styles.card}>
            <h1 className={styles.heading}>What would you like to do?</h1>
            {SECTIONS.map(({title, cards}) => (
                <div key={title} className={styles.section}>
                    <h2 className={styles.sectionTitle}>{title}</h2>
                    <div className={styles.modeGrid}>
                        {cards.map(m => (
                            <ModeCard key={m.id} mode={m} onClick={onSelectMode} />
                        ))}
                    </div>
                </div>
            ))}
        </div>
    </div>
);

HomeScreen.propTypes = {
    onSelectMode: PropTypes.func.isRequired
};

export default HomeScreen;
