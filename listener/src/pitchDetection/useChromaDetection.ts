/**
 * Chroma-based real-time pitch detection using the Web Audio API AnalyserNode.
 *
 * Pipeline:
 *   getUserMedia → AnalyserNode (FFT) → chroma vector (12 pitch classes)
 *   → rolling smoothing → relative threshold → Set<midiNote>
 *
 * Latency: ~50–150 ms (no ML model, no CDN dependency).
 */

import { useCallback, useRef, useState } from 'react';
import type { PitchDetectionResult, PitchDetectionStatus } from './PitchDetectionTypes';

// ── Constants ────────────────────────────────────────────────────────────────

/** FFT size – higher = better frequency resolution (must be a power of 2). */
const FFT_SIZE = 8192;

/** Number of analysis frames to average the chroma vector over (~150 ms at 50 ms/tick). */
const SMOOTHING_FRAMES = 3;

/** Minimum average-per-bin energy before any chord detection is attempted. */
const MIN_PEAK_ENERGY = 10;

/** Time between analysis ticks in milliseconds. */
const ANALYSIS_INTERVAL_MS = 50;

/**
 * Minimum average normalised score for a chord template match to be accepted.
 * Score = (sum of smoothed chroma values at the 3 chord notes) / (3 × maxEnergy).
 * 0.60 means the three chord notes average at least 60 % of the peak note's energy.
 * This is robust against harmonic bleed (e.g. G's 3rd harmonic → D) because the
 * full chord template must score together — a single boosted harmonic cannot win.
 */
const CHORD_MIN_SCORE = 0.60;

/**
 * Sliding-window vote: number of recent ticks kept for stability voting.
 * At 50 ms/tick this covers 400 ms of history.
 */
const CANDIDATE_WINDOW_SIZE = 8;

/**
 * A chord is activated / switched-to when it wins at least this many ticks in the window.
 * Minimum activation latency = CANDIDATE_MIN_WINS × 50 ms = 250 ms.
 * A transient that lasts fewer than CANDIDATE_MIN_WINS ticks can never trigger activation.
 */
const CANDIDATE_MIN_WINS = 5;

/**
 * Active chord is cleared once its vote count in the window drops below this value.
 * Equivalent to ~6–7 consecutive silent ticks ≈ 300–350 ms of silence.
 */
const CANDIDATE_DEACTIVATE_MIN = 3;

// ── Chord templates ──────────────────────────────────────────────────────────

const NOTE_NAMES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const;

/** Circle-of-fifths root order — mirrors useCircleOfFifthsDetection. */
const MAJOR_ROOTS = [0, 7, 2, 9, 4, 11, 6, 1, 8, 3, 10, 5];
const MINOR_ROOTS = [9, 4, 11, 6, 1, 8, 3, 10, 5, 0, 7, 2];

const CHORD_TEMPLATES: Array<{ notes: number[]; midiNotes: number[]; label: string }> = [
    ...MAJOR_ROOTS.map(r => ({
        notes:     [r, (r + 4) % 12, (r + 7) % 12],
        midiNotes: [60 + r, 60 + (r + 4) % 12, 60 + (r + 7) % 12],
        label:     `${NOTE_NAMES[r]} maj`,
    })),
    ...MINOR_ROOTS.map(r => ({
        notes:     [r, (r + 3) % 12, (r + 7) % 12],
        midiNotes: [60 + r, 60 + (r + 3) % 12, 60 + (r + 7) % 12],
        label:     `${NOTE_NAMES[r]} min`,
    })),
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a frequency in Hz to a (floating-point) MIDI note number. */
function freqToMidi(freq: number, a4Hz: number): number {
    return 12 * Math.log2(freq / a4Hz) + 69;
}

/**
 * Build a lookup table: FFT bin index → pitch class (0–11).
 * Returns null for bins outside the piano frequency range (A0 ≈ 27.5 Hz – C8 ≈ 4186 Hz).
 * Uses a4Hz as the concert-A reference (default 440 Hz).
 */
function buildBinToPitchClass(fftSize: number, sampleRate: number, a4Hz: number): (number | null)[] {
    const binCount = fftSize / 2;
    const binHz    = sampleRate / fftSize;
    const map: (number | null)[] = new Array(binCount).fill(null);
    for (let i = 1; i < binCount; i++) {
        const freq = i * binHz;
        if (freq < 27.5 || freq > 4200) continue;
        const pc = ((Math.round(freqToMidi(freq, a4Hz)) % 12) + 12) % 12;
        map[i] = pc;
    }
    return map;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useChromaDetection(): PitchDetectionResult {
    const [status, setStatus]           = useState<PitchDetectionStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [pressedNotes, setPressedNotes] = useState<Set<number>>(new Set());

    const audioCtxRef      = useRef<AudioContext | null>(null);
    const analyserRef      = useRef<AnalyserNode | null>(null);
    const streamRef        = useRef<MediaStream | null>(null);
    const intervalRef      = useRef<ReturnType<typeof setInterval> | null>(null);
    const isActiveRef      = useRef(false);
    const binToPcRef       = useRef<(number | null)[] | null>(null);
    const binsPerPcRef     = useRef<number[]>(new Array(12).fill(0));
    const chromaHistRef    = useRef<number[][]>([]);
    // Chord template matching state
    const recentCandidatesRef = useRef<number[]>([]); // sliding-window vote buffer (−1 = no chord)
    const activeChordRef   = useRef(-1);  // index of currently reported chord (−1 = none)
    const logTickRef       = useRef(0);

    // ── stop ─────────────────────────────────────────────────────────────────

    const stop = useCallback(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        streamRef.current?.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close();

        intervalRef.current = null;
        streamRef.current   = null;
        audioCtxRef.current = null;
        analyserRef.current = null;
        isActiveRef.current       = false;
        chromaHistRef.current     = [];
        recentCandidatesRef.current = [];
        activeChordRef.current    = -1;

        setPressedNotes(new Set());
        setStatus('idle');
    }, []);

    // ── start ─────────────────────────────────────────────────────────────────

    const start = useCallback(async (a4Hz: number = 440) => {
        if (isActiveRef.current) return;
        isActiveRef.current = true;

        setStatus('requesting');
        setErrorMessage(null);
        setPressedNotes(new Set());

        try {
            // 1. Microphone access
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl:  false,
                },
                video: false,
            });
            streamRef.current = stream;

            // 2. Build Web Audio pipeline (no model load needed → no 'loading' phase)
            const AudioCtorRaw =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioCtorRaw();
            await ctx.resume();
            audioCtxRef.current = ctx;

            const analyser = ctx.createAnalyser();
            analyser.fftSize = FFT_SIZE;
            // Light browser-side smoothing; we do our own rolling average on top
            analyser.smoothingTimeConstant = 0.5;
            analyserRef.current = analyser;

            // Connect source → analyser only (no output → no microphone feedback)
            const source = ctx.createMediaStreamSource(stream);
            source.connect(analyser);

            // 3. Pre-compute bin→pitch-class lookup table
            const binToPc   = buildBinToPitchClass(FFT_SIZE, ctx.sampleRate, a4Hz);
            binToPcRef.current = binToPc;

            const binsPerPc = new Array(12).fill(0);
            for (const pc of binToPc) {
                if (pc !== null) binsPerPc[pc]++;
            }
            binsPerPcRef.current = binsPerPc;

            console.log(
                `[ChromaDetection] AudioContext SR: ${ctx.sampleRate} Hz` +
                ` | FFT bins: ${analyser.frequencyBinCount}` +
                ` | bins per PC: [${binsPerPc.join(', ')}]`
            );

            setStatus('active');

            // 4. Periodic chroma analysis
            const freqData = new Uint8Array(analyser.frequencyBinCount);

            intervalRef.current = setInterval(() => {
                const an = analyserRef.current;
                if (!an) return;
                an.getByteFrequencyData(freqData);

                // Compute per-pitch-class average bin energy (0–255 scale)
                const chromaSum = new Array(12).fill(0);
                for (let i = 0; i < freqData.length; i++) {
                    const pc = binToPc[i];
                    if (pc !== null) chromaSum[pc] += freqData[i];
                }
                const chroma = chromaSum.map((s, pc) =>
                    binsPerPc[pc] > 0 ? s / binsPerPc[pc] : 0
                );

                // Rolling smoothing over last SMOOTHING_FRAMES frames
                chromaHistRef.current.push(chroma);
                if (chromaHistRef.current.length > SMOOTHING_FRAMES) {
                    chromaHistRef.current.shift();
                }
                const nFrames  = chromaHistRef.current.length;
                const smoothed = new Array(12).fill(0);
                for (const frame of chromaHistRef.current) {
                    for (let pc = 0; pc < 12; pc++) smoothed[pc] += frame[pc];
                }
                for (let pc = 0; pc < 12; pc++) smoothed[pc] /= nFrames;

                const maxEnergy = Math.max(...smoothed);

                // ── Chord template matching ───────────────────────────────────
                // Score each chord: average normalised energy of its 3 notes.
                // Naturally handles harmonic bleed: a chord requires ALL 3 notes
                // to be strong — a single harmonic cannot push a wrong chord above threshold.
                let bestIdx   = -1;
                let bestScore = 0;

                if (maxEnergy >= MIN_PEAK_ENERGY) {
                    for (let i = 0; i < CHORD_TEMPLATES.length; i++) {
                        const score =
                            CHORD_TEMPLATES[i].notes.reduce((s, pc) => s + smoothed[pc], 0) /
                            (CHORD_TEMPLATES[i].notes.length * maxEnergy);
                        if (score > bestScore) { bestScore = score; bestIdx = i; }
                    }
                    if (bestScore < CHORD_MIN_SCORE) bestIdx = -1;
                }

                // ── Sliding-window stability vote ─────────────────────────────
                // Push this tick's best candidate into the rolling window.
                // A chord is only activated/switched-to when it wins the majority
                // of recent ticks, which filters out sub-200 ms transients while
                // keeping minimum activation latency at CANDIDATE_MIN_WINS × 50 ms.
                recentCandidatesRef.current.push(bestIdx);
                if (recentCandidatesRef.current.length > CANDIDATE_WINDOW_SIZE) {
                    recentCandidatesRef.current.shift();
                }

                // Count votes for each chord index in the window (−1 excluded)
                const voteCounts = new Map<number, number>();
                for (const idx of recentCandidatesRef.current) {
                    if (idx !== -1) voteCounts.set(idx, (voteCounts.get(idx) ?? 0) + 1);
                }

                // Find the dominant chord (most votes, must reach CANDIDATE_MIN_WINS)
                let dominantIdx   = -1;
                let dominantCount = 0;
                for (const [idx, count] of voteCounts) {
                    if (count > dominantCount) { dominantCount = count; dominantIdx = idx; }
                }
                if (dominantCount < CANDIDATE_MIN_WINS) dominantIdx = -1;

                // ── Activate / switch ─────────────────────────────────────────
                if (dominantIdx !== -1 && dominantIdx !== activeChordRef.current) {
                    const tmpl = CHORD_TEMPLATES[dominantIdx];
                    activeChordRef.current = dominantIdx;
                    setPressedNotes(new Set(tmpl.midiNotes));
                    console.log(
                        `[ChromaDetection] Chord: ${tmpl.label}` +
                        ` | score: ${bestScore.toFixed(2)}` +
                        ` | maxEnergy: ${maxEnergy.toFixed(1)}` +
                        ` | votes: ${dominantCount}/${recentCandidatesRef.current.length}`
                    );
                }

                // ── Deactivate ────────────────────────────────────────────────
                // Clear the active chord only when no chord is dominant AND the
                // active chord's own vote count has fallen below the deactivation
                // threshold (i.e. the musician has released the keys long enough).
                if (activeChordRef.current !== -1 && dominantIdx === -1) {
                    const activeCount = voteCounts.get(activeChordRef.current) ?? 0;
                    if (activeCount < CANDIDATE_DEACTIVATE_MIN) {
                        activeChordRef.current = -1;
                        setPressedNotes(new Set());
                        console.log('[ChromaDetection] Chord cleared');
                    }
                }

                // ── Periodic debug log (every ~1 s) ──────────────────────────
                logTickRef.current++;
                if (logTickRef.current % 20 === 0) {
                    const top3 = [...smoothed]
                        .map((e, pc) => ({ pc, e }))
                        .sort((a, b) => b.e - a.e)
                        .slice(0, 3)
                        .map(({ pc, e }) => `${NOTE_NAMES[pc]}:${e.toFixed(1)}`);
                    const bestLabel = bestIdx >= 0 ? CHORD_TEMPLATES[bestIdx].label : '—';
                    console.log(
                        `[ChromaDetection] maxEnergy: ${maxEnergy.toFixed(1)}` +
                        ` | top: ${top3.join('  ')}` +
                        ` | best: ${bestLabel} (${bestScore.toFixed(2)})`
                    );
                }

            }, ANALYSIS_INTERVAL_MS);

        } catch (err: unknown) {
            isActiveRef.current = false;
            setStatus('error');
            const domErr = err as DOMException | Error;
            const name   = (domErr as DOMException)?.name ?? '';
            let msg: string;
            if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
                msg = 'MICROPHONE_DENIED';
            } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
                msg = 'MICROPHONE_NOT_FOUND';
            } else if (name === 'NotReadableError' || name === 'TrackStartError') {
                msg = 'MICROPHONE_IN_USE';
            } else if (name === 'SecurityError') {
                msg = 'MICROPHONE_DENIED';
            } else {
                msg = domErr?.message ?? 'UNKNOWN';
            }
            setErrorMessage(msg);
        }
    }, []);

    return { status, errorMessage, pressedNotes, start, stop };
}
