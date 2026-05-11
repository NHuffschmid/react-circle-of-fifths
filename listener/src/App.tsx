import React, { useCallback, useEffect, useRef, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { CircleOfFifths } from '../../src';
import { useCircleOfFifthsDetection } from '../../src/useCircleOfFifthsDetection';
import { usePitchDetection } from './pitchDetection';
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
        else if (!isBusy) void start();
    }, [isActive, isBusy, start, stop]);

    return (
        <div className="app-root">

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
                                // Stop icon: filled square via CSS
                                ? <span className="btn-icon-stop" style={{ width: Math.round(btnSize * 0.28), height: Math.round(btnSize * 0.28) }} />
                                // Play icon: right-pointing triangle via CSS borders
                                : <span className="btn-icon-play" style={{ borderTop: `${Math.round(btnSize * 0.17)}px solid transparent`, borderBottom: `${Math.round(btnSize * 0.17)}px solid transparent`, borderLeft: `${Math.round(btnSize * 0.28)}px solid #fff`, marginLeft: Math.round(btnSize * 0.05) }} />
                            }
                        </button>
                    </div>
                </div>
            </div>

            {/* ── Footer ───────────────────────────────────────────────────── */}
            <footer className="app-footer">
                {/* Error message (only shown when status === 'error') */}
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

                {/* Loading indicator (nur für Modell-Laden, nicht für Requesting microphone) */}
                {isBusy && status === 'loading' && (
                    <p className="loading-text">
                        <>Loading model… <LoadingDots /></>
                    </p>
                )}

                {/* QR code – centered between circle and impressum link */}
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

                {/* Impressum link */}
                <a
                    href={`${import.meta.env.BASE_URL}impressum/index.html`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="impressum-link"
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
