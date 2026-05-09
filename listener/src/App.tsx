import React, { useCallback, useState } from 'react';
import { CircleOfFifths } from '../../src';
import { useCircleOfFifthsDetection } from '../../src/useCircleOfFifthsDetection';
import { usePitchDetection } from './pitchDetection';
import type { PitchDetectionStatus } from './pitchDetection';

// ── Types ─────────────────────────────────────────────────────────────────────

type Language = 'de' | 'en' | 'fr' | 'it' | 'es';

// ── Status helpers ────────────────────────────────────────────────────────────

const STATUS_LABEL: Record<PitchDetectionStatus, string> = {
    idle:       'Press Start to begin listening',
    requesting: 'Waiting for microphone permission…',
    loading:    'Loading model (~20 MB, first time only)…',
    active:     '● Listening',
    error:      'Error',
};

// ── Component ─────────────────────────────────────────────────────────────────

function App() {
    const [language, setLanguage] = useState<Language>('en');

    const { status, errorMessage, pressedNotes, start, stop } = usePitchDetection();
    const { selectedMajorKeys, selectedMinorKeys, dominantSeventhMajorKeys } =
        useCircleOfFifthsDetection(pressedNotes);

    const isActive = status === 'active';
    const isBusy   = status === 'requesting' || status === 'loading';

    const handleToggle = useCallback(() => {
        if (isActive)                     stop();
        else if (!isBusy) void start();
    }, [isActive, isBusy, start, stop]);

    const statusText  = status === 'error' ? (errorMessage ?? 'Error') : STATUS_LABEL[status];
    const statusColor = status === 'error' ? '#ff6b6b' : status === 'active' ? '#4caf50' : '#888';

    return (
        <div style={{
            width: '100vw',
            height: '100dvh',          // dvh = dynamic viewport height (accounts for mobile browser chrome)
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            backgroundColor: '#111',
            color: '#fff',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            overflow: 'hidden',
            userSelect: 'none',
        }}>

            {/* ── Header ───────────────────────────────────────────────────── */}
            <header style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                width: '100%',
                padding: '12px 16px',
                boxSizing: 'border-box',
                flexShrink: 0,
                borderBottom: '1px solid #222',
            }}>
                <h1 style={{
                    margin: 0,
                    fontSize: '0.95rem',
                    fontWeight: 600,
                    letterSpacing: '0.04em',
                    whiteSpace: 'nowrap',
                }}>
                    Circle of Fifths · Live
                </h1>

                <select
                    value={language}
                    onChange={e => setLanguage(e.target.value as Language)}
                    aria-label="Note name language"
                    style={{
                        background: '#1e1e1e',
                        color: '#ccc',
                        border: '1px solid #333',
                        borderRadius: 6,
                        padding: '4px 8px',
                        fontSize: '0.85rem',
                        cursor: 'pointer',
                        outline: 'none',
                    }}
                >
                    <option value="en">EN</option>
                    <option value="de">DE</option>
                    <option value="fr">FR</option>
                    <option value="it">IT</option>
                    <option value="es">ES</option>
                </select>
            </header>

            {/* ── Circle of Fifths ─────────────────────────────────────────── */}
            <div style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                minHeight: 0,
                padding: '8px',
                boxSizing: 'border-box',
            }}>
                <div style={{
                    width:    'min(88vw, 88vh, 520px)',
                    height:   'min(88vw, 88vh, 520px)',
                    position: 'relative',
                }}>
                    <CircleOfFifths
                        selectedMajorKeys={selectedMajorKeys}
                        selectedMinorKeys={selectedMinorKeys}
                        dominantSeventhMajorKeys={dominantSeventhMajorKeys}
                        language={language}
                    />
                </div>
            </div>

            {/* ── Footer ───────────────────────────────────────────────────── */}
            <footer style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 10,
                padding: '10px 16px 24px',
                flexShrink: 0,
                width: '100%',
                boxSizing: 'border-box',
            }}>
                {/* Status line */}
                <p style={{
                    margin: 0,
                    fontSize: '0.8rem',
                    color: statusColor,
                    textAlign: 'center',
                    minHeight: '1.3em',
                    transition: 'color 0.3s',
                }}>
                    {isBusy
                        ? <>{statusText} <LoadingDots /></>
                        : statusText
                    }
                </p>

                {/* Start / Stop button */}
                <button
                    onClick={handleToggle}
                    disabled={isBusy}
                    aria-label={isActive ? 'Stop listening' : 'Start listening'}
                    style={{
                        background:   isBusy   ? '#2a2a2a'
                                    : isActive ? '#b71c1c'
                                    :            '#1b5e20',
                        color:        '#fff',
                        border:       'none',
                        borderRadius: 28,
                        padding:      '13px 44px',
                        fontSize:     '1rem',
                        fontWeight:   600,
                        cursor:       isBusy ? 'default' : 'pointer',
                        opacity:      isBusy ? 0.5 : 1,
                        transition:   'background 0.25s, opacity 0.25s',
                        minWidth:     160,
                        touchAction:  'manipulation', // removes 300 ms tap delay on mobile
                        WebkitTapHighlightColor: 'transparent',
                    }}
                >
                    {isBusy ? '…' : isActive ? 'Stop' : 'Start'}
                </button>
            </footer>
        </div>
    );
}

// ── Loading animation ─────────────────────────────────────────────────────────

function LoadingDots() {
    return (
        <span aria-hidden>
            <style>{`
                @keyframes cof-dot-blink {
                    0%, 80%, 100% { opacity: 0.2; }
                    40%           { opacity: 1;   }
                }
                .cof-dot { animation: cof-dot-blink 1.4s infinite ease-in-out; display: inline-block; }
                .cof-dot:nth-child(2) { animation-delay: 0.2s; }
                .cof-dot:nth-child(3) { animation-delay: 0.4s; }
            `}</style>
            <span className="cof-dot">.</span>
            <span className="cof-dot">.</span>
            <span className="cof-dot">.</span>
        </span>
    );
}

export default App;
