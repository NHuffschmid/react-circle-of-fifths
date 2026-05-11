import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CircleOfFifths } from '../../src';
import { useCircleOfFifthsDetection } from '../../src/useCircleOfFifthsDetection';
import { usePitchDetection } from './pitchDetection';

// ── Constants ─────────────────────────────────────────────────────────────────

type Language = 'de' | 'en' | 'fr' | 'it' | 'es';

const SUPPORTED_LANGUAGES: Language[] = ['de', 'en', 'fr', 'it', 'es'];

function detectBrowserLanguage(): Language {
    const lang = (navigator.language ?? '').slice(0, 2).toLowerCase() as Language;
    return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'en';
}

const QR_URL = 'https://nhuffschmid.github.io/react-circle-of-fifths/';

// ── Localised error messages ──────────────────────────────────────────────────

const MIC_ERRORS: Record<string, Record<Language, { title: string; hint: string }>> = {
    MICROPHONE_DENIED: {
        de: { title: 'Mikrofonzugriff verweigert', hint: 'Bitte erlaube den Mikrofonzugriff in den Browser-Einstellungen und versuche es erneut.' },
        en: { title: 'Microphone access denied',  hint: 'Please allow microphone access in your browser settings and try again.' },
        fr: { title: 'Accès au microphone refusé', hint: 'Veuillez autoriser l’accès au microphone dans les paramètres du navigateur.' },
        it: { title: 'Accesso al microfono negato', hint: 'Consenti l’accesso al microfono nelle impostazioni del browser e riprova.' },
        es: { title: 'Acceso al micrófono denegado', hint: 'Permite el acceso al micrófono en los ajustes del navegador e inténtalo de nuevo.' },
    },
    MICROPHONE_NOT_FOUND: {
        de: { title: 'Kein Mikrofon gefunden', hint: 'Stelle sicher, dass ein Mikrofon angeschlossen oder aktiviert ist.' },
        en: { title: 'No microphone found',    hint: 'Make sure a microphone is connected and enabled.' },
        fr: { title: 'Aucun microphone trouvé', hint: 'Vérifiez qu’un microphone est connecté et activé.' },
        it: { title: 'Nessun microfono trovato', hint: 'Assicurati che un microfono sia collegato e abilitato.' },
        es: { title: 'No se encontró micrófono', hint: 'Asegúrate de que haya un micrófono conectado y habilitado.' },
    },
    MICROPHONE_IN_USE: {
        de: { title: 'Mikrofon wird verwendet', hint: 'Das Mikrofon wird von einer anderen App genutzt. Schließe sie und versuche es erneut.' },
        en: { title: 'Microphone is in use',   hint: 'Another app is using the microphone. Close it and try again.' },
        fr: { title: 'Microphone déjà utilisé', hint: 'Une autre application utilise le microphone. Fermez-la et réessayez.' },
        it: { title: 'Microfono in uso',        hint: 'Un’altra app sta usando il microfono. Chiudila e riprova.' },
        es: { title: 'Micrófono en uso',        hint: 'Otra aplicación está usando el micrófono. Ciérrala e inténtalo de nuevo.' },
    },
};

function getMicError(code: string | null, lang: Language) {
    if (!code) return null;
    return MIC_ERRORS[code]?.[lang] ?? null;
}

// ── Component ─────────────────────────────────────────────────────────────────

function App() {
    const [language, setLanguage] = useState<Language>(detectBrowserLanguage);

    // Sync <html lang> so the browser doesn't offer to translate the page
    useEffect(() => {
        document.documentElement.lang = language;
    }, [language]);

    const { status, errorMessage, pressedNotes, start, stop } = usePitchDetection();
    const { selectedMajorKeys, selectedMinorKeys, dominantSeventhMajorKeys } =
        useCircleOfFifthsDetection(pressedNotes);

    const isActive = status === 'active';
    const isBusy   = status === 'requesting' || status === 'loading';

    // Screen Wake Lock – keep the display on while the listener is running
    const wakeLockRef = useRef<WakeLockSentinel | null>(null);
    useEffect(() => {
        if (!('wakeLock' in navigator)) return;
        if (isActive) {
            navigator.wakeLock.request('screen')
                .then(lock => { wakeLockRef.current = lock; })
                .catch(() => { /* permission denied or not supported – ignore */ });
        } else {
            wakeLockRef.current?.release().catch(() => {});
            wakeLockRef.current = null;
        }
        return () => {
            wakeLockRef.current?.release().catch(() => {});
            wakeLockRef.current = null;
        };
    }, [isActive]);

    const handleToggle = useCallback(() => {
        if (isActive)         stop();
        else if (!isBusy) void start();
    }, [isActive, isBusy, start, stop]);

    return (
        <div style={{
            width: '100vw',
            height: '100dvh',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            backgroundColor: '#111',
            color: '#fff',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            overflow: 'hidden',
            userSelect: 'none',
        }}>
            <style>{`
                @keyframes cof-btn-pulse {
                    0%, 100% { background: #b71c1c; box-shadow: 0 0 0 0 rgba(183,28,28,0.7); }
                    50%      { background: #e53935; box-shadow: 0 0 0 10px rgba(183,28,28,0); }
                }
                @keyframes cof-dot-blink {
                    0%, 80%, 100% { opacity: 0.2; }
                    40%           { opacity: 1;   }
                }
                .cof-dot { animation: cof-dot-blink 1.4s infinite ease-in-out; display: inline-block; }
                .cof-dot:nth-child(2) { animation-delay: 0.2s; }
                .cof-dot:nth-child(3) { animation-delay: 0.4s; }
            `}</style>

            {/* ── Language selector (top-right overlay) ─────────────────── */}
            <div style={{
                position: 'absolute',
                top: 12,
                right: 16,
                zIndex: 10,
            }}>
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
            </div>

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
                        accentColor="#555"
                    />
                    {/* Start/Stop Button in the center */}
                    <div style={{
                        position:  'absolute',
                        left:      '50%',
                        top:       '50%',
                        transform: 'translate(-50%, -50%)',
                        zIndex:    3,
                        pointerEvents: 'auto',
                        display:   'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                    }}>
                        <button
                            onClick={handleToggle}
                            disabled={isBusy}
                            aria-label={isActive ? 'Stop listening' : 'Start listening'}
                            style={{
                                background:   isBusy   ? '#2a2a2a'
                                            : isActive ? '#b71c1c'
                                            :            '#1b5e20',
                                animation:    isActive ? 'cof-btn-pulse 1.4s ease-in-out infinite' : 'none',
                                color:        '#fff',
                                border:       'none',
                                borderRadius: '50%',
                                width:        128,
                                height:       128,
                                fontSize:     '3.2rem',
                                lineHeight:   1,
                                cursor:       isBusy ? 'default' : 'pointer',
                                opacity:      isBusy ? 0.4 : 1,
                                transition:   'background 0.25s, opacity 0.25s',
                                touchAction:  'manipulation',
                                WebkitTapHighlightColor: 'transparent',
                                display:      'flex',
                                alignItems:   'center',
                                justifyContent: 'center',
                            }}
                        >
                            {isBusy
                                // Animated dots – plain text, no emoji
                                ? <><span className="cof-dot">&#9679;</span><span className="cof-dot">&#9679;</span><span className="cof-dot">&#9679;</span></>
                                : isActive
                                // Stop icon: filled square via CSS
                                ? <span style={{ display: 'block', width: 36, height: 36, background: '#fff', borderRadius: 4 }} />
                                // Play icon: right-pointing triangle via CSS borders
                                : <span style={{ display: 'block', width: 0, height: 0, borderTop: '22px solid transparent', borderBottom: '22px solid transparent', borderLeft: '36px solid #fff', marginLeft: 6 }} />
                            }
                        </button>
                    </div>
                </div>
            </div>

            {/* ── Footer ───────────────────────────────────────────────────── */}
            <footer style={{
                display:        'flex',
                flexDirection:  'column',
                alignItems:     'center',
                gap:            8,
                padding:        '8px 16px 12px',
                flexShrink:     0,
                width:          '100%',
                boxSizing:      'border-box',
            }}>
                {/* Error message (only shown when status === 'error') */}
                {status === 'error' && (() => {
                    const localised = getMicError(errorMessage, language);
                    return (
                        <div style={{ margin: 0, textAlign: 'center' }}>
                            <p style={{ margin: '0 0 4px', fontSize: '0.82rem', color: '#ff6b6b', fontWeight: 600 }}>
                                {localised?.title ?? errorMessage ?? 'Error'}
                            </p>
                            {localised && (
                                <p style={{ margin: 0, fontSize: '0.75rem', color: '#ff9999', maxWidth: 280 }}>
                                    {localised.hint}
                                </p>
                            )}
                        </div>
                    );
                })()}

                {/* Loading indicator (nur für Modell-Laden, nicht für Requesting microphone) */}
                {isBusy && status === 'loading' && (
                    <p style={{ margin: 0, fontSize: '0.78rem', color: '#888', textAlign: 'center' }}>
                        <>Loading model… <LoadingDots /></>
                    </p>
                )}

                {/* QR code – centered between circle and impressum link */}
                <div style={{
                    marginTop: 12,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                }}>
                    <QRCodeSVG
                        value={QR_URL}
                        level="Q"
                        style={{ width: 128, height: 128 }}
                        bgColor="#111"
                        fgColor="#fff"
                        imageSettings={{
                            src: `${import.meta.env.BASE_URL}favicon.ico`,
                            height: 40,
                            width:  40,
                            excavate: true,
                        }}
                    />
                </div>

                {/* Impressum link */}
                <a
                    href={`${import.meta.env.BASE_URL}impressum/index.html`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                        color: '#888',
                        fontSize: '0.8rem',
                        textDecoration: 'underline',
                        marginTop: 6,
                    }}
                >
                    Impressum / Legal Notice
                </a>
            </footer>
        </div>
    );
}

// ── Loading animation ─────────────────────────────────────────────────────────

function LoadingDots() {
    return (
        <span aria-hidden>
            <span className="cof-dot">.</span>
            <span className="cof-dot">.</span>
            <span className="cof-dot">.</span>
        </span>
    );
}

export default App;
