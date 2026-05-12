import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CircleOfFifths } from '../../src';
import { useCircleOfFifthsDetection } from '../../src/useCircleOfFifthsDetection';
import { usePitchDetection } from './pitchDetection';
import {
    useTuningCalibration,
    readA4Hz,
    writeA4Hz,
    resetA4Hz,
    DEFAULT_A4_HZ,
} from './pitchDetection/useTuningCalibration';
import './App.css';

// ── Constants ─────────────────────────────────────────────────────────────────

type Language = 'de' | 'en' | 'fr' | 'it' | 'es' | 'pt';

const SUPPORTED_LANGUAGES: Language[] = ['de', 'en', 'fr', 'it', 'es', 'pt'];

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
        pt: { title: 'Acesso ao microfone negado', hint: 'Permita o acesso ao microfone nas configurações do navegador e tente novamente.' },
    },
    MICROPHONE_NOT_FOUND: {
        de: { title: 'Kein Mikrofon gefunden', hint: 'Stelle sicher, dass ein Mikrofon angeschlossen oder aktiviert ist.' },
        en: { title: 'No microphone found',    hint: 'Make sure a microphone is connected and enabled.' },
        fr: { title: 'Aucun microphone trouvé', hint: 'Vérifiez qu’un microphone est connecté et activé.' },
        it: { title: 'Nessun microfono trovato', hint: 'Assicurati che un microfono sia collegato e abilitato.' },
        es: { title: 'No se encontró micrófono', hint: 'Asegúrate de que haya un micrófono conectado y habilitado.' },
        pt: { title: 'Nenhum microfone encontrado', hint: 'Certifique-se de que um microfone está conectado e ativado.' },
    },
    MICROPHONE_IN_USE: {
        de: { title: 'Mikrofon wird verwendet', hint: 'Das Mikrofon wird von einer anderen App genutzt. Schließe sie und versuche es erneut.' },
        en: { title: 'Microphone is in use',   hint: 'Another app is using the microphone. Close it and try again.' },
        fr: { title: 'Microphone déjà utilisé', hint: 'Une autre application utilise le microphone. Fermez-la et réessayez.' },
        it: { title: 'Microfono in uso',        hint: 'Un’altra app sta usando il microfono. Chiudila e riprova.' },
        es: { title: 'Micrófono en uso',        hint: 'Otra aplicación está usando el micrófono. Ciérrala e inténtalo de nuevo.' },
        pt: { title: 'Microfone em uso',         hint: 'Outro aplicativo está usando o microfone. Feche-o e tente novamente.' },
    },
};

function getMicError(code: string | null, lang: Language) {
    if (!code) return null;
    return MIC_ERRORS[code]?.[lang] ?? null;
}

// ── Calibration localisation ──────────────────────────────────────────────────

const CAL_LABELS: Record<Language, {
    tooltip:     string;
    title:       string;
    instruction: string;
    retry:       string;
    close:       string;
    done:        (hz: number) => string;
    error:       string;
    cancel:      string;
    reset:       string;
}> = {
    de: {
        tooltip:     'Kalibrierung',
        title:       'Kammerton kalibrieren',
        instruction: 'Schlag den Kammerton A an und halte ihn.',
        retry:       'Erneut messen',
        close:       'Schließen',
        done:        (hz) => `Kalibriert: ${hz.toFixed(1)} Hz`,
        error:       'Kein klarer Ton erkannt. Bitte versuche es erneut.',
        cancel:      'Abbrechen',
        reset:       'Zurücksetzen (440 Hz)',
    },
    en: {
        tooltip:     'Tuning calibration',
        title:       'Calibrate concert pitch',
        instruction: 'Play concert A and hold it.',
        retry:       'Measure again',
        close:       'Close',
        done:        (hz) => `Calibrated: ${hz.toFixed(1)} Hz`,
        error:       'No clear pitch detected. Please try again.',
        cancel:      'Cancel',
        reset:       'Reset to 440 Hz',
    },
    fr: {
        tooltip:     'Calibration',
        title:       'Calibrer le la de concert',
        instruction: 'Jouez le la de concert et tenez-le.',
        retry:       'Mesurer à nouveau',
        close:       'Fermer',
        done:        (hz) => `Calibré : ${hz.toFixed(1)} Hz`,
        error:       'Aucune hauteur claire détectée. Veuillez réessayer.',
        cancel:      'Annuler',
        reset:       'Réinitialiser (440 Hz)',
    },
    it: {
        tooltip:     'Calibrazione',
        title:       'Calibra il diapason',
        instruction: 'Suona il la di concerto e tienilo.',
        retry:       'Misura di nuovo',
        close:       'Chiudi',
        done:        (hz) => `Calibrato: ${hz.toFixed(1)} Hz`,
        error:       'Nessuna nota chiara rilevata. Riprova.',
        cancel:      'Annulla',
        reset:       'Ripristina (440 Hz)',
    },
    es: {
        tooltip:     'Calibración',
        title:       'Calibrar el diapasón',
        instruction: 'Toca el la de concierto y mantenlo.',
        retry:       'Medir de nuevo',
        close:       'Cerrar',
        done:        (hz) => `Calibrado: ${hz.toFixed(1)} Hz`,
        error:       'No se detectó un tono claro. Inténtalo de nuevo.',
        cancel:      'Cancelar',
        reset:       'Restablecer (440 Hz)',
    },
    pt: {
        tooltip:     'Calibração',
        title:       'Calibrar o diapasão',
        instruction: 'Toque o lá de concerto e segure-o.',
        retry:       'Medir novamente',
        close:       'Fechar',
        done:        (hz) => `Calibrado: ${hz.toFixed(1)} Hz`,
        error:       'Nenhum tom claro detectado. Tente novamente.',
        cancel:      'Cancelar',
        reset:       'Redefinir (440 Hz)',
    },
};

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

    // ── Concert-A calibration ─────────────────────────────────────────────────
    const [a4Hz, setA4Hz] = useState<number>(readA4Hz);
    const cal = useTuningCalibration();

    // When calibration succeeds, persist and update the reference frequency
    useEffect(() => {
        if (cal.status === 'done' && cal.measuredHz !== null) {
            writeA4Hz(cal.measuredHz);
            setA4Hz(cal.measuredHz);
        }
    }, [cal.status, cal.measuredHz]);

    const isCalibrationOpen =
        cal.status === 'listening' || cal.status === 'done' || cal.status === 'error';

    const handleTuneForkClick = useCallback(() => {
        if (isCalibrationOpen) {
            cal.cancel();
        } else {
            // Stop the main listener before calibration
            if (isActive) stop();
            void cal.start();
        }
    }, [isCalibrationOpen, cal, isActive, stop]);

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

    // Circle container size tracking – drives the adaptive button size
    const circleContainerRef = useRef<HTMLDivElement>(null);
    const [circleSize, setCircleSize] = useState(400);
    useEffect(() => {
        const el = circleContainerRef.current;
        if (!el) return;
        const ro = new ResizeObserver(entries => {
            const { width, height } = entries[0].contentRect;
            setCircleSize(Math.min(width, height));
        });
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // Button diameter: fits within the innermost SVG circle
    // (R_ACC_INNER = 58 in a 400-unit viewBox → 29 % of container; use 85 % of that)
    const btnSize = Math.max(40, Math.round(circleSize * 0.246));

    const handleToggle = useCallback(() => {
        if (isActive)         stop();
        else if (!isBusy) void start(a4Hz);
    }, [isActive, isBusy, start, stop, a4Hz]);

    return (
        <div className="app-root">

            {/* ── Tuning fork button (top-left) ─────────────────────────── */}
            <div className="tune-btn-wrap">
                <button
                    className={`tune-btn${a4Hz !== DEFAULT_A4_HZ ? ' tune-btn--calibrated' : ''}`}
                    onClick={handleTuneForkClick}
                    aria-label={CAL_LABELS[language].tooltip}
                    title={CAL_LABELS[language].tooltip}
                >
                    <TuningForkIcon />
                    {a4Hz !== DEFAULT_A4_HZ && (
                        <span className="tune-btn__badge">{a4Hz.toFixed(0)} Hz</span>
                    )}
                </button>
            </div>

            {/* ── Calibration overlay ───────────────────────────────────── */}
            {isCalibrationOpen && (
                <div className="cal-overlay" role="dialog" aria-modal="true"
                     aria-label={CAL_LABELS[language].title}>
                    <div className="cal-card">
                        <p className="cal-title">{CAL_LABELS[language].title}</p>

                        {cal.status === 'listening' && (
                            <>
                                <p className="cal-instruction">
                                    {CAL_LABELS[language].instruction}
                                </p>
                                <div className="cal-progress-track">
                                    <div
                                        className="cal-progress-bar"
                                        style={{ width: `${cal.progress * 100}%` }}
                                    />
                                </div>
                            </>
                        )}

                        {cal.status === 'done' && cal.measuredHz !== null && (
                            <p className="cal-result cal-result--ok">
                                {CAL_LABELS[language].done(cal.measuredHz)}
                            </p>
                        )}

                        {cal.status === 'error' && (
                            <p className="cal-result cal-result--err">
                                {CAL_LABELS[language].error}
                            </p>
                        )}

                        <div className="cal-actions">
                            {cal.status === 'listening' && (
                                <button className="cal-btn" onClick={cal.cancel}>
                                    {CAL_LABELS[language].cancel}
                                </button>
                            )}
                            {(cal.status === 'done' || cal.status === 'error') && (
                                <button className="cal-btn cal-btn--primary"
                                    onClick={() => void cal.start()}>
                                    {CAL_LABELS[language].retry}
                                </button>
                            )}
                            {(cal.status === 'done' || cal.status === 'error') && (
                                <button className="cal-btn" onClick={cal.cancel}>
                                    {CAL_LABELS[language].close}
                                </button>
                            )}
                            {a4Hz !== DEFAULT_A4_HZ && (
                                <button className="cal-btn cal-btn--reset" onClick={() => {
                                    resetA4Hz();
                                    setA4Hz(DEFAULT_A4_HZ);
                                    cal.cancel();
                                }}>
                                    {CAL_LABELS[language].reset}
                                </button>
                            )}
                        </div>
                    </div>
                </div>
            )}

            {/* ── Language selector (top-right overlay) ─────────────────── */}
            <div className="lang-selector">
                <select
                    value={language}
                    onChange={e => setLanguage(e.target.value as Language)}
                    aria-label="Note name language"
                    className="lang-select"
                >
                    <option value="en">EN</option>
                    <option value="de">DE</option>
                    <option value="fr">FR</option>
                    <option value="it">IT</option>
                    <option value="es">ES</option>
                    <option value="pt">PT</option>
                </select>
            </div>

            {/* ── Circle of Fifths ─────────────────────────────────────────── */}
            <div className="circle-area">
                <div ref={circleContainerRef} className="circle-container">
                    <CircleOfFifths
                        selectedMajorKeys={selectedMajorKeys}
                        selectedMinorKeys={selectedMinorKeys}
                        dominantSeventhMajorKeys={dominantSeventhMajorKeys}
                        language={language}
                        accentColor="#555"
                        opacityOn={1.0}
                        opacityOff={isActive ? 0.35 : 0.2}
                    />
                    {/* Start/Stop Button in the center */}
                    <div className="btn-overlay">
                        <button
                            onClick={handleToggle}
                            disabled={isBusy}
                            aria-label={isActive ? 'Stop listening' : 'Start listening'}
                            className={`cof-btn ${isBusy ? 'cof-btn--busy' : isActive ? 'cof-btn--active' : 'cof-btn--idle'}`}
                            style={{
                                width:    btnSize,
                                height:   btnSize,
                                fontSize: Math.round(btnSize * 0.4),
                            }}
                        >
                            {isBusy
                                // Animated dots – plain text, no emoji
                                ? <><span className="cof-dot">&#9679;</span><span className="cof-dot">&#9679;</span><span className="cof-dot">&#9679;</span></>
                                : isActive
                                // Microphone icon (active state)
                                ? <MicIcon size={Math.round(btnSize * 0.52)} />
                                // Play icon: right-pointing triangle via CSS borders
                                : <span className="btn-icon-play" style={{ borderTop: `${Math.round(btnSize * 0.17)}px solid transparent`, borderBottom: `${Math.round(btnSize * 0.17)}px solid transparent`, borderLeft: `${Math.round(btnSize * 0.28)}px solid #fff`, marginLeft: Math.round(btnSize * 0.05) }} />
                            }
                        </button>
                    </div>
                </div>
            </div>

            {/* ── Status messages (bottom centre) ────────────────────────── */}
            {(status === 'error' || (isBusy && status === 'loading')) && (
                <div className="status-messages">
                    {status === 'error' && (() => {
                        const localised = getMicError(errorMessage, language);
                        return (
                            <div className="error-box">
                                <p className="error-title">
                                    {localised?.title ?? errorMessage ?? 'Error'}
                                </p>
                                {localised && (
                                    <p className="error-hint">
                                        {localised.hint}
                                    </p>
                                )}
                            </div>
                        );
                    })()}
                    {isBusy && status === 'loading' && (
                        <p className="loading-text">
                            <>Loading model… <LoadingDots /></>
                        </p>
                    )}
                </div>
            )}

            {/* ── QR code (bottom-left) ────────────────────────────────────── */}
            {!isActive && (
                <div className="qr-wrapper">
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
            )}

            {/* ── Impressum link (bottom-right) ────────────────────────────── */}
            <a
                href={`${import.meta.env.BASE_URL}impressum/index.html`}
                target="_blank"
                rel="noopener noreferrer"
                className="impressum-link"
            >
                Impressum / Legal Notice
            </a>
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

// ── Tuning fork SVG icon ──────────────────────────────────────────────────────

function TuningForkIcon() {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ width: '1.6em', height: '1.6em', display: 'block' }}
        >
            {/*
             * Tuning fork: two prongs open at the top, compact U-arc at the
             * bottom, and a stem going down.
             *
             *   |   |   ← left tine (x=9.5) and right tine (x=14.5)
             *   |   |
             *    \_/    ← arc radius 2.5 at y=12
             *     |     ← stem (x=12, y=15→22)
             */}
            {/* Left tine */}
            <line x1="9.5"  y1="2" x2="9.5"  y2="12" />
            {/* Arc curving toward the tines (sweep-flag=0 → bows upward) */}
            <path d="M9.5 12 A2.5 2.5 0 0 0 14.5 12" />
            {/* Right tine */}
            <line x1="14.5" y1="12" x2="14.5" y2="2" />
            {/* Stem */}
            <line x1="12" y1="14.5" x2="12" y2="22" />
        </svg>
    );
}

// ── Microphone SVG icon ───────────────────────────────────────────────────────

function MicIcon({ size }: { size: number }) {
    return (
        <svg
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            style={{ width: size, height: size, display: 'block' }}
        >
            {/* Capsule body – filled */}
            <rect x="9" y="2" width="6" height="12" rx="3" ry="3" fill="currentColor" stroke="none" />
            {/* Arc / sound pickup curve */}
            <path d="M5 10 A7 7 0 0 0 19 10" />
            {/* Stand */}
            <line x1="12" y1="17" x2="12" y2="22" />
            {/* Base */}
            <line x1="8"  y1="22" x2="16" y2="22" />
        </svg>
    );
}

export default App;
