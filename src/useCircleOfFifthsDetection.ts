import { MutableRefObject, useEffect, useMemo, useRef, useState } from 'react';

// ── Key-detection constants ───────────────────────────────────────────────────

/** Duration in ms of the sliding note-accumulation window. */
const WINDOW_MS = 2000;

/** Duration of the longer window used only for major/minor discrimination. */
const LONG_WINDOW_MS = 6000;

/** Minimum unique pitch classes to enter passage mode (diatonic overlap). */
const MIN_DIATONIC_PCS = 5;

/** Minimum diatonic overlap score required in passage mode. */
const MIN_DIATONIC_SCORE = 4;

/**
 * Root pitch-class for each circle-of-fifths index (0 = C, 1 = C#, …).
 * Major order: C G D A E B F# C# G# D# A# F
 */
const MAJOR_ROOTS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];

/**
 * Root pitch-class for each circle-of-fifths minor index.
 * Minor order: a e b f# c# g# d# a# f c g d
 */
const MINOR_ROOTS = [9, 4, 11, 6, 1, 8, 3, 10, 5, 0, 7, 2];

// ── Tonic triads (chord mode: 3–4 unique pitch classes) ──────────────────────
const MAJOR_TONIC_SETS = MAJOR_ROOTS.map(r => new Set([r, (r + 4) % 12, (r + 7) % 12]));
const MINOR_TONIC_SETS = MINOR_ROOTS.map(r => new Set([r, (r + 3) % 12, (r + 7) % 12]));

// ── Dominant seventh chords (chord mode: exactly 4 unique pitch classes) ──────
const DOMINANT_7TH_SETS = MAJOR_ROOTS.map(r =>
    new Set([r, (r + 4) % 12, (r + 7) % 12, (r + 10) % 12]),
);

// ── Diatonic scales (passage mode: 5+ unique pitch classes) ──────────────────
const MAJOR_SCALE_SETS = [
    [0, 2, 4, 5, 7, 9, 11],  // C  major
    [7, 9, 11, 0, 2, 4, 6],  // G  major
    [2, 4, 6, 7, 9, 11, 1],  // D  major
    [9, 11, 1, 2, 4, 6, 8],  // A  major
    [4, 6, 8, 9, 11, 1, 3],  // E  major
    [11, 1, 3, 4, 6, 8, 10], // B  major
    [6, 8, 10, 11, 1, 3, 5], // F# major
    [1, 3, 5, 6, 8, 10, 0],  // C# major
    [8, 10, 0, 1, 3, 5, 7],  // G# major
    [3, 5, 7, 8, 10, 0, 2],  // D# major
    [10, 0, 2, 3, 5, 7, 9],  // A# major
    [5, 7, 9, 10, 0, 2, 4],  // F  major
].map(pcs => new Set(pcs));

const MINOR_SCALE_SETS = [
    [9, 11, 0, 2, 4, 5, 7],  // a  minor
    [4, 6, 7, 9, 11, 0, 2],  // e  minor
    [11, 1, 2, 4, 6, 7, 9],  // b  minor
    [6, 8, 9, 11, 1, 2, 4],  // f# minor
    [1, 3, 4, 6, 8, 9, 11],  // c# minor
    [8, 10, 11, 1, 3, 4, 6], // g# minor
    [3, 5, 6, 8, 10, 11, 1], // d# minor
    [10, 0, 1, 3, 5, 6, 8],  // a# minor
    [5, 7, 8, 10, 0, 1, 3],  // f  minor
    [0, 2, 3, 5, 7, 8, 10],  // c  minor
    [7, 9, 10, 0, 2, 3, 5],  // g  minor
    [2, 4, 5, 7, 9, 10, 0],  // d  minor
].map(pcs => new Set(pcs));

// ── Types ─────────────────────────────────────────────────────────────────────

export interface CircleOfFifthsDetectionResult {
    /** Circle-of-fifths indices of detected major keys (empty = none). */
    selectedMajorKeys: number[];
    /** Circle-of-fifths indices of detected minor keys (empty = none). */
    selectedMinorKeys: number[];
    /**
     * Circle-of-fifths indices of dominant seventh chords (empty = none).
     * E.g. playing G7 yields index 1 (G), displayed with a superscript "7".
     */
    dominantSeventhMajorKeys: number[];
}

// ── Hook ──────────────────────────────────────────────────────────────────────

/**
 * Detects the current musical key from a set of simultaneously pressed MIDI notes.
 *
 * Uses a two-window sliding accumulation strategy:
 *
 * Mode A — Chord (3–4 unique pitch classes in the 2-second window):
 *   Tonic-triad and dominant-seventh matching.
 *
 * Mode B — Passage (5+ unique pitch classes in the 2-second window):
 *   Diatonic scale overlap, discriminated by a 6-second long window.
 *
 * @param pressedNotes - The set of currently pressed MIDI note numbers.
 *   Pass an empty set (not undefined) to pause detection without unmounting.
 */
export function useCircleOfFifthsDetection(
    pressedNotes: Set<number>,
): CircleOfFifthsDetectionResult {
    const windowRef = useRef<Array<{ note: number; time: number }>>([]);
    const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const longWindowRef = useRef<Array<{ note: number; time: number }>>([]);
    const longTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const prevNotesRef = useRef<Set<number>>(new Set());
    const activeNotesRef = useRef<Set<number>>(new Set());
    const [windowNotes, setWindowNotes] = useState<Set<number>>(new Set());
    const [longPcFreq, setLongPcFreq] = useState<Map<number, number>>(new Map());

    useEffect(() => {
        activeNotesRef.current = pressedNotes;

        // When notes are released, clear the windows immediately instead of
        // waiting up to WINDOW_MS (2 s) for the timer to expire.
        if (pressedNotes.size === 0 && prevNotesRef.current.size > 0) {
            windowRef.current = [];
            longWindowRef.current = [];
            if (timerRef.current !== null) { clearTimeout(timerRef.current); timerRef.current = null; }
            if (longTimerRef.current !== null) { clearTimeout(longTimerRef.current); longTimerRef.current = null; }
            setWindowNotes(new Set());
            setLongPcFreq(new Map());
            prevNotesRef.current = new Set();
            return;
        }

        const prev = prevNotesRef.current;
        const now = Date.now();
        let newNoteOn = false;

        for (const note of pressedNotes) {
            if (!prev.has(note)) {
                const ev = { note, time: now };
                windowRef.current.push(ev);
                longWindowRef.current.push(ev);
                newNoteOn = true;
            }
        }

        if (newNoteOn) {
            const pressedResult = computeKeyDetection(new Set(pressedNotes));
            const shouldReset =
                pressedResult.selectedMajorKeys.length > 0 ||
                pressedResult.selectedMinorKeys.length > 0;

            if (shouldReset) {
                windowRef.current = [...pressedNotes].map(note => ({ note, time: now }));
                longWindowRef.current = [...pressedNotes].map(note => ({ note, time: now }));
            } else {
                windowRef.current = windowRef.current
                    .filter(e => now - e.time < WINDOW_MS || pressedNotes.has(e.note))
                    .map(e => pressedNotes.has(e.note) ? { note: e.note, time: now } : e);
                longWindowRef.current = longWindowRef.current
                    .filter(e => now - e.time < LONG_WINDOW_MS || pressedNotes.has(e.note))
                    .map(e => pressedNotes.has(e.note) ? { note: e.note, time: now } : e);
            }

            setWindowNotes(new Set(windowRef.current.map(e => e.note)));

            if (timerRef.current) clearTimeout(timerRef.current);
            const scheduleWindowExpiry = () => {
                timerRef.current = setTimeout(function tick() {
                    const t = Date.now();
                    windowRef.current = windowRef.current
                        .filter(e => activeNotesRef.current.has(e.note))
                        .map(e => ({ note: e.note, time: t }));
                    setWindowNotes(new Set(windowRef.current.map(e => e.note)));
                    if (windowRef.current.length > 0) {
                        timerRef.current = setTimeout(tick, WINDOW_MS);
                    }
                }, WINDOW_MS);
            };
            scheduleWindowExpiry();

            const rebuildLongFreq = () => {
                const freqMap = new Map<number, number>();
                for (const e of longWindowRef.current) {
                    const pc = e.note % 12;
                    freqMap.set(pc, (freqMap.get(pc) ?? 0) + 1);
                }
                setLongPcFreq(freqMap);
            };
            rebuildLongFreq();

            if (longTimerRef.current) clearTimeout(longTimerRef.current);
            const scheduleLongExpiry = () => {
                longTimerRef.current = setTimeout(function tick() {
                    const t = Date.now();
                    longWindowRef.current = longWindowRef.current
                        .filter(e => activeNotesRef.current.has(e.note))
                        .map(e => ({ note: e.note, time: t }));
                    rebuildLongFreq();
                    if (longWindowRef.current.length > 0) {
                        longTimerRef.current = setTimeout(tick, LONG_WINDOW_MS);
                    }
                }, LONG_WINDOW_MS);
            };
            scheduleLongExpiry();
        }

        prevNotesRef.current = new Set(pressedNotes);
    }, [pressedNotes]);

    // Cleanup timers on unmount.
    useEffect(() => {
        return () => {
            if (timerRef.current !== null) {
                clearTimeout(timerRef.current);
                timerRef.current = null;
            }
            if (longTimerRef.current !== null) {
                clearTimeout(longTimerRef.current);
                longTimerRef.current = null;
            }
        };
    }, []);

    return useMemo(() => {
        const raw = computeKeyDetection(windowNotes);
        const discriminated = discriminateMajorMinor(raw, longPcFreq);
        return { ...discriminated, dominantSeventhMajorKeys: raw.dominantSeventhMajorKeys };
    }, [windowNotes, longPcFreq]);
}

// ── Core detection (pure) ─────────────────────────────────────────────────────

export function computeKeyDetection(windowNotes: Set<number>): CircleOfFifthsDetectionResult {
    if (windowNotes.size === 0) {
        return { selectedMajorKeys: [], selectedMinorKeys: [], dominantSeventhMajorKeys: [] };
    }

    const pcs = new Set<number>();
    for (const note of windowNotes) pcs.add(note % 12);

    const selectedMajorKeys: number[] = [];
    const selectedMinorKeys: number[] = [];
    const dominantSeventhMajorKeys: number[] = [];

    if (pcs.size >= MIN_DIATONIC_PCS) {
        // ── Passage mode: diatonic overlap ────────────────────────────────────
        const majorScores = MAJOR_SCALE_SETS.map(scale => { let n = 0; for (const pc of pcs) if (scale.has(pc)) n++; return n; });
        const minorScores = MINOR_SCALE_SETS.map(scale => { let n = 0; for (const pc of pcs) if (scale.has(pc)) n++; return n; });
        const maxMajor = Math.max(...majorScores);
        const maxMinor = Math.max(...minorScores);
        if (maxMajor >= MIN_DIATONIC_SCORE) majorScores.forEach((s, i) => { if (s === maxMajor) selectedMajorKeys.push(i); });
        if (maxMinor >= MIN_DIATONIC_SCORE) minorScores.forEach((s, i) => { if (s === maxMinor) selectedMinorKeys.push(i); });
    } else if (pcs.size >= 3) {
        // ── Chord mode: tonic-triad matching ──────────────────────────────────
        for (let i = 0; i < 12; i++) {
            if (pcs.has(MAJOR_ROOTS[i]) && [...pcs].every(pc => MAJOR_TONIC_SETS[i].has(pc))) selectedMajorKeys.push(i);
            if (pcs.has(MINOR_ROOTS[i]) && [...pcs].every(pc => MINOR_TONIC_SETS[i].has(pc))) selectedMinorKeys.push(i);
        }
        // ── Dominant seventh chord detection (exactly 4 pitch classes) ────────
        if (pcs.size === 4 && selectedMajorKeys.length === 0 && selectedMinorKeys.length === 0) {
            for (let i = 0; i < 12; i++) {
                if ([...pcs].every(pc => DOMINANT_7TH_SETS[i].has(pc))) {
                    dominantSeventhMajorKeys.push(i);
                }
            }
        }
    }

    return { selectedMajorKeys, selectedMinorKeys, dominantSeventhMajorKeys };
}

// ── Major/minor discriminator ─────────────────────────────────────────────────

/**
 * Post-processing step applied on top of the existing detection result.
 *
 * - Relative pairs: major vs its relative minor (same key signature) — the one
 *   whose root appears less frequently in the 6-second window is removed.
 * - Parallel pairs: major vs minor with the same root — the one whose third
 *   (major or minor) appears less frequently is removed.
 *
 * If frequencies are equal, both candidates are kept unchanged.
 */
export function discriminateMajorMinor(
    result: CircleOfFifthsDetectionResult,
    longPcFreq: Map<number, number>,
): Omit<CircleOfFifthsDetectionResult, 'dominantSeventhMajorKeys'> {
    if (result.selectedMajorKeys.length === 0 || result.selectedMinorKeys.length === 0) {
        return result;
    }
    if (longPcFreq.size === 0) {
        return result;
    }

    const majorToRemove = new Set<number>();
    const minorToRemove = new Set<number>();

    // ── Relative pairs: major vs its relative minor (same key signature) ──────
    for (const majIdx of result.selectedMajorKeys) {
        const majRoot = MAJOR_ROOTS[majIdx];
        const relMinorRoot = (majRoot + 9) % 12;
        const relMinorIdx = result.selectedMinorKeys.find(mIdx => MINOR_ROOTS[mIdx] === relMinorRoot);
        if (relMinorIdx === undefined) continue;

        const majFreq = longPcFreq.get(majRoot) ?? 0;
        const minFreq = longPcFreq.get(relMinorRoot) ?? 0;
        if (majFreq > minFreq) {
            minorToRemove.add(relMinorIdx);
        } else if (minFreq > majFreq) {
            majorToRemove.add(majIdx);
        }
    }

    // ── Parallel pairs: major vs minor with the same root ─────────────────────
    for (const majIdx of result.selectedMajorKeys) {
        if (majorToRemove.has(majIdx)) continue;
        const majRoot = MAJOR_ROOTS[majIdx];
        const parMinorIdx = result.selectedMinorKeys.find(
            mIdx => MINOR_ROOTS[mIdx] === majRoot && !minorToRemove.has(mIdx),
        );
        if (parMinorIdx === undefined) continue;

        const majorThirdFreq = longPcFreq.get((majRoot + 4) % 12) ?? 0;
        const minorThirdFreq = longPcFreq.get((majRoot + 3) % 12) ?? 0;
        if (majorThirdFreq > minorThirdFreq) {
            minorToRemove.add(parMinorIdx);
        } else if (minorThirdFreq > majorThirdFreq) {
            majorToRemove.add(majIdx);
        }
    }

    if (majorToRemove.size === 0 && minorToRemove.size === 0) {
        return result;
    }

    const filteredMajor = result.selectedMajorKeys.filter(i => !majorToRemove.has(i));
    const filteredMinor = result.selectedMinorKeys.filter(i => !minorToRemove.has(i));

    if (filteredMajor.length > 0 && filteredMinor.length === 0) {
        return { selectedMajorKeys: filteredMajor, selectedMinorKeys: [] };
    }
    if (filteredMinor.length > 0 && filteredMajor.length === 0) {
        return { selectedMajorKeys: [], selectedMinorKeys: filteredMinor };
    }
    return { selectedMajorKeys: filteredMajor, selectedMinorKeys: filteredMinor };
}
