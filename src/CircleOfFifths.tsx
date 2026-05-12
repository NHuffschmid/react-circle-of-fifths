import React from 'react';
import { skrjabinColors, NOTE_NAMES, resolveLanguage } from 'react-piano-keyboard';
import type { SupportedLanguage } from 'react-piano-keyboard';

export interface CircleOfFifthsProps {
    /** Selected major key indices (0 = C, clockwise). Display-only – no click interaction. */
    selectedMajorKeys?: number[];
    /** Selected minor key indices (0 = am, clockwise). Display-only – no click interaction. */
    selectedMinorKeys?: number[];
    /** Major key indices highlighted as dominant seventh chords (shown with superscript "7"). */
    dominantSeventhMajorKeys?: number[];
    /**
     * BCP-47 language tag (or bare language code) for note name labels.
     * Falls back to 'en' if not supported. Supported: 'de', 'en', 'fr', 'it', 'es', 'pt'.
     */
    language?: string;
    /**
     * Accent color used for the accidentals (key signature) ring.
     * Accepts any valid CSS color string. Default: '#DC143C'.
     */
    accentColor?: string;
    /**
     * Opacity of a segment in the ON (selected / highlighted) state.
     * Range 0–1. Default: 0.9.
     */
    opacityOn?: number;
    /**
     * Opacity of a segment in the OFF (non-selected) state while a selection is active.
     * Range 0–1. Default: 0.20.
     */
    opacityOff?: number;
}

// Accidentals for each index (sharps: ♯, flats: ♭, empty for C).
const ACCIDENTALS = ['', '1♯', '2♯', '3♯', '4♯', '5♯', '6♭/6♯', '5♭', '4♭', '3♭', '2♭', '1♭'];

// ── SVG geometry constants ───────────────────────────────────────────────────

const CX = 200;
const CY = 200;

const R_MAJOR_OUTER = 192;
const R_MAJOR_INNER = 138;
const R_MINOR_OUTER = 135;
const R_MINOR_INNER = 91;
const R_ACC_OUTER = 88;
const R_ACC_INNER = 58;

/** Each segment spans 28° (leaving a 2° visual gap between neighbours). */
const SEGMENT_SPAN_DEG = 28;

// ── Helpers ──────────────────────────────────────────────────────────────────

const toRad = (deg: number) => (deg * Math.PI) / 180;

/**
 * Maps a Circle-of-Fifths index (0=C, 1=G, 2=D, …) to a chromatic index (0=C, 1=C#, …).
 * Required because skrjabinColors is indexed chromatically.
 */
const FIFTHS_TO_CHROMATIC = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

/** Returns the Skrjabin colour for a circle-of-fifths segment index. */
const skrjabinFill = (index: number) => skrjabinColors[FIFTHS_TO_CHROMATIC[index]] ?? '#888888';

/**
 * Derives the major key label for a circle-of-fifths segment from NOTE_NAMES.
 */
function getMajorKeyLabel(lang: SupportedLanguage, fifthsIndex: number): string {
    const { primary, secondary } = NOTE_NAMES[lang][FIFTHS_TO_CHROMATIC[fifthsIndex]];
    if (fifthsIndex === 6) return `${secondary}/${primary}`;
    if (fifthsIndex >= 7 && fifthsIndex <= 10) return secondary ?? primary;
    return primary;
}

/**
 * Derives the relative minor key label for a circle-of-fifths segment from NOTE_NAMES.
 * The relative minor is 9 semitones above (a minor third below) the major key.
 */
function getMinorKeyLabel(lang: SupportedLanguage, fifthsIndex: number): string {
    const chromaticIndex = (FIFTHS_TO_CHROMATIC[fifthsIndex] + 9) % 12;
    const { primary, secondary } = NOTE_NAMES[lang][chromaticIndex];
    if (fifthsIndex === 6) return `${secondary}/${primary}`.toLowerCase();
    if (fifthsIndex >= 7 && fifthsIndex <= 10) return (secondary ?? primary).toLowerCase();
    return primary.toLowerCase();
}

/**
 * Returns '#000' for light backgrounds and '#fff' for dark ones (WCAG luminance threshold).
 * Input must be a 6-digit hex color string starting with '#'.
 */
function labelColor(hex: string): string {
    const r = parseInt(hex.slice(1, 3), 16) / 255;
    const g = parseInt(hex.slice(3, 5), 16) / 255;
    const b = parseInt(hex.slice(5, 7), 16) / 255;
    const toLinear = (c: number) => c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const L = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    return L > 0.179 ? '#000' : '#fff';
}

/** Darkened (50% brightness) version of the Skrjabin colour for the minor/accidentals ring. */
function skrjabinFillDim(index: number): string {
    const hex = skrjabinFill(index).replace('#', '');
    const r = Math.round(parseInt(hex.slice(0, 2), 16) * 0.45);
    const g = Math.round(parseInt(hex.slice(2, 4), 16) * 0.45);
    const b = Math.round(parseInt(hex.slice(4, 6), 16) * 0.45);
    return `rgb(${r},${g},${b})`;
}

function arcPath(rInner: number, rOuter: number, centerDeg: number): string {
    const half = SEGMENT_SPAN_DEG / 2;
    const a1 = toRad(centerDeg - half);
    const a2 = toRad(centerDeg + half);
    const xi1 = CX + rInner * Math.cos(a1), yi1 = CY + rInner * Math.sin(a1);
    const xi2 = CX + rInner * Math.cos(a2), yi2 = CY + rInner * Math.sin(a2);
    const xo1 = CX + rOuter * Math.cos(a1), yo1 = CY + rOuter * Math.sin(a1);
    const xo2 = CX + rOuter * Math.cos(a2), yo2 = CY + rOuter * Math.sin(a2);
    return `M ${xi1} ${yi1} A ${rInner} ${rInner} 0 0 1 ${xi2} ${yi2} ` +
           `L ${xo2} ${yo2} A ${rOuter} ${rOuter} 0 0 0 ${xo1} ${yo1} Z`;
}

/** Centre angle (degrees) for segment i: C at 12 o'clock (−90°), clockwise. */
const segAngle = (i: number) => -90 + i * 30;

// ── Opacity constants ────────────────────────────────────────────────────────
/** Opacity of a selected segment. */
const OPACITY_SELECTED = 0.9;
/** Opacity of a non-selected segment. */
const OPACITY_DIMMED = 0.20;

// ── Component ────────────────────────────────────────────────────────────────

const CircleOfFifths: React.FC<CircleOfFifthsProps> = ({
    selectedMajorKeys,
    selectedMinorKeys,
    dominantSeventhMajorKeys,
    language,
    accentColor = '#DC143C',
    opacityOn  = OPACITY_SELECTED,
    opacityOff = OPACITY_DIMMED,
}) => {
    const lang = resolveLanguage(language?.split('-')[0] ?? 'en');

    const selMajor = selectedMajorKeys ?? [];
    const selMinor = selectedMinorKeys ?? [];
    const selDom7  = dominantSeventhMajorKeys ?? [];

    return (
        <div style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            zIndex: 1,
        }}>
            <svg
                viewBox="0 0 400 400"
                style={{
                    width: '100%',
                    height: '100%',
                    pointerEvents: 'none',
                }}
            >
                {Array.from({ length: 12 }, (_, i) => {
                    const angle = segAngle(i);
                    const rad   = toRad(angle);
                    const majSel  = selMajor.includes(i);
                    const minSel  = selMinor.includes(i);
                    const dom7Sel = selDom7.includes(i);

                    const majOpacity = (majSel || dom7Sel) ? opacityOn : opacityOff;
                    const minOpacity = minSel ? opacityOn : opacityOff;
                    const accOpacity = (majSel || minSel || dom7Sel) ? opacityOn : opacityOff;

                    const majMidR = (R_MAJOR_INNER + R_MAJOR_OUTER) / 2;
                    const minMidR = (R_MINOR_INNER + R_MINOR_OUTER) / 2;
                    const accMidR = (R_ACC_INNER + R_ACC_OUTER) / 2;
                    const tx = (r: number) => CX + r * Math.cos(rad);
                    const ty = (r: number) => CY + r * Math.sin(rad);

                    return (
                        <g key={i}>
                            {/* ── Major ring ── */}
                            <g opacity={majOpacity}>
                                <path
                                    d={arcPath(R_MAJOR_INNER, R_MAJOR_OUTER, angle)}
                                    fill={skrjabinFill(i)}
                                    stroke={majSel ? 'white' : '#111'}
                                    strokeWidth={majSel ? 2.5 : 0.8}
                                />
                                <text
                                    x={tx(majMidR)} y={ty(majMidR)}
                                    textAnchor="middle" dominantBaseline="central"
                                    fontSize={(majSel || dom7Sel) ? 24 : 21}
                                    fontWeight={(majSel || dom7Sel) ? 'bold' : 'normal'}
                                    fill={labelColor(skrjabinFill(i))}
                                    style={{ userSelect: 'none' }}
                                >
                                    {getMajorKeyLabel(lang, i)}
                                    {dom7Sel && (
                                        <tspan
                                            fontSize={(majSel || dom7Sel) ? 14 : 12}
                                            dy={-(((majSel || dom7Sel) ? 24 : 21) * 0.45)}
                                        >7</tspan>
                                    )}
                                </text>
                            </g>
                            {/* ── Minor ring ── */}
                            <g opacity={minOpacity}>
                                <path
                                    d={arcPath(R_MINOR_INNER, R_MINOR_OUTER, angle)}
                                    fill={skrjabinFillDim(i)}
                                    stroke={minSel ? 'white' : '#111'}
                                    strokeWidth={minSel ? 2.5 : 0.8}
                                />
                                <text
                                    x={tx(minMidR)} y={ty(minMidR)}
                                    textAnchor="middle" dominantBaseline="central"
                                    fontSize={minSel ? 19 : 16}
                                    fontWeight={minSel ? 'bold' : 'normal'}
                                    fill='#fff'
                                    style={{ userSelect: 'none' }}
                                >
                                    {getMinorKeyLabel(lang, i)}
                                </text>
                            </g>
                            {/* ── Accidentals ring ── */}
                            {ACCIDENTALS[i] && (
                                <g opacity={accOpacity}>
                                    <path
                                        d={arcPath(R_ACC_INNER, R_ACC_OUTER, angle)}
                                        fill={accentColor}
                                        stroke="#111"
                                        strokeWidth={0.8}
                                    />
                                    <text
                                        x={tx(accMidR)} y={ty(accMidR)}
                                        textAnchor="middle" dominantBaseline="central"
                                        fontSize={14}
                                        fill="#fff"
                                        fontFamily="'Noto Serif', 'Noto Sans Symbols', 'Segoe UI Symbol', 'Apple Symbols', serif"
                                        style={{ userSelect: 'none' }}
                                    >
                                        {ACCIDENTALS[i]}
                                    </text>
                                </g>
                            )}
                        </g>
                    );
                })}
            </svg>
        </div>
    );
};

export default CircleOfFifths;
