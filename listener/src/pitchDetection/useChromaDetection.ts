/**
 * Chroma-based real-time pitch detection using the Web Audio API AnalyserNode.
 *
 * Pipeline:
 *   getUserMedia → AnalyserNode (FFT) → chroma vector (12 pitch classes)
 *   → chord template matching → stability voting → Set<midiNote>
 *
 * Latency: ~250–400 ms (no ML model, no CDN dependency).
 */

import { useCallback, useRef, useState } from 'react';
import type { PitchDetectionResult, PitchDetectionStatus } from './PitchDetectionTypes';

// ── Constants ────────────────────────────────────────────────────────────────

/** FFT size – higher = better frequency resolution (must be a power of 2). */
const FFT_SIZE = 8192;


/** Minimum average-per-bin energy before any chord detection is attempted. */
const MIN_PEAK_ENERGY = 10;

/** Time between analysis ticks in milliseconds. */
const ANALYSIS_INTERVAL_MS = 50;

/**
 * Minimum average normalised score for a chord template match to be accepted
 * when no chord is currently active (first activation from silence).
 * Score = (sum of per-tick chroma values at the 3 chord notes) / (3 × maxEnergy).
 * 0.55 means the three chord notes average at least 55 % of the peak note's energy.
 * Lowered from 0.60: some chords (e.g. D major on piano) fluctuate between 0.56–0.77
 * due to overtone overlap, and the stricter 0.60 gate broke consecutive runs mid-chord.
 */
const CHORD_MIN_SCORE = 0.55;

/**
 * Higher score required when *switching* from one active chord to another.
 * During a piano attack, the mixed signal (decaying old chord + noisy new attack)
 * can push a wrong-chord template above CHORD_MIN_SCORE but rarely above this
 * value. A clean sustained chord reliably scores ≥ 0.82.
 * Using a higher gate here means we never switch through an intermediate wrong
 * chord: the active chord stays visible until a genuinely confident new chord
 * is ready to take over directly.
 */
const CHORD_SWITCH_SCORE = 0.80;

/**
 * Sliding-window vote: number of recent ticks kept for stability voting.
 * At 50 ms/tick this covers 750 ms of history.
 */
const CANDIDATE_WINDOW_SIZE = 15;

/**
 * A chord is activated / switched-to only when it appears in this many *consecutive*
 * ticks at the tail of the sliding window.
 * Minimum activation latency = CANDIDATE_MIN_WINS × 50 ms = 250 ms.
 *
 * Consecutive (not total-count) voting is the key improvement over the previous approach:
 * piano attack transients affect only the first 1–3 ticks after a key strike. Because those
 * wrong-chord ticks are immediately followed by correct-chord ticks, the wrong chord can
 * never build up a consecutive run of CANDIDATE_MIN_WINS — so it is never activated.
 * The old count-in-window approach allowed wrong-chord votes to accumulate across the full
 * window and thus briefly activate a wrong key when the attack transient was long enough.
 */
const CANDIDATE_MIN_WINS = 5;

/**
 * Onset detection: if the raw (unsmoothed, single-tick) chroma max energy rises by
 * more than this factor in one 50 ms tick, a new chord onset is assumed.
 * On onset the candidate vote window is flushed so that decaying strings from
 * the previously-released chord cannot score into the new chord's template matches.
 *
 * Root cause this solves: A major {A, C#, E} and E major {E, G#, B} share no
 * pitch class, but C# minor {C#, E, G#} has exactly the two that overlap the
 * transition (C# decaying from A major + G# freshly struck in E major + shared E).
 * During the decay/attack overlap C# minor genuinely scores ≥ 0.85, far above
 * CHORD_SWITCH_SCORE — no score gate can block it. Flushing the buffers on onset
 * makes the new chord start with a clean slate so the old decay is invisible.
 *
 * 1.5 = 50 % increase triggers an onset. Raise toward 2.0 if false onsets occur
 * with loud sustain pedal resonance; lower toward 1.3 if soft playing misses onsets.
 */
const ONSET_RATIO = 1.5;

/**
 * Minimum time in milliseconds a chord must remain visible before it can be
 * replaced by a newly confirmed chord.
 * This is the primary safeguard against display flutter: even if the algorithm
 * confidently detects a new chord within 250 ms, it cannot update the display
 * until the current chord has been shown for at least this long.
 * Effect: if the musician plays one chord every 1 s, the display updates at most
 * once every MIN_HOLD_MS — matching the actual playing tempo.
 * First activation from silence is not gated (MIN_HOLD_MS only applies to
 * chord-to-chord switches).
 */
const MIN_HOLD_MS = 750;

/**
 * Milliseconds without a confirmed chord win before the active chord display
 * is cleared. The "last confirmed" timestamp is updated on any tick where the
 * active chord is the best match and has score ≥ CHORD_MIN_SCORE.
 * When the player releases the keys (or a different chord dominates), confirmations
 * stop updating. After DEACTIVATE_INACTIVITY_MS without confirmation, the display clears.
 *
 * Advantages over raw-energy or bestIdx-based approaches:
 *  • Immune to room reverb and piano string resonance (no energy threshold needed).
 *  • Works at any timer resolution (Android Chrome fires at ~100 ms, not 50 ms).
 *  • During a chord switch the new chord quickly re-activates and replaces the
 *    old one directly — the timer is just a safety net if no new chord follows.
 *
 * With analyser.smoothingTimeConstant = 0.2, the AnalyserNode energy clears in ~1 tick after key
 * release, so the timer starts almost immediately. 300 ms gives a comfortable
 * buffer without a noticeable display lag on both desktop and Android.
 */
const DEACTIVATE_INACTIVITY_MS = 300;

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

/** Convert a MIDI note number to a frequency in Hz. */
function midiToFreq(midi: number, a4Hz: number): number {
    return a4Hz * Math.pow(2, (midi - 69) / 12);
}

/**
 * Detect missing bass fundamentals via harmonic series analysis.
 *
 * Problem: Standard microphones barely capture fundamentals below 100 Hz (bass register),
 * but harmonics (2f, 3f, 4f, ...) are clearly audible. This causes C2-E2-G2 bass chords
 * to be detected as G major (because the 3rd harmonics G3, B3, D4 dominate the spectrum).
 *
 * Solution: For each bass note (A0–C3, MIDI 21–48), check if a harmonic series
 * (2f, 3f, 4f, 5f, 6f, 7f, 8f) is present in the FFT spectrum. If multiple harmonics
 * are found, reconstruct the missing fundamental and add it to the chroma vector.
 *
 * This mimics psychoacoustic "missing fundamental" perception: your brain recognizes
 * a note from its overtone pattern even when the fundamental is inaudible.
 *
 * @param freqData - Raw FFT bin magnitudes (0–255 scale)
 * @param sampleRate - AudioContext sample rate (typically 48000 Hz)
 * @param fftSize - FFT size (typically 8192)
 * @param a4Hz - Concert A reference (typically 440 Hz)
 * @returns Map of MIDI note → reconstructed energy (0–255 scale)
 */
function detectMissingFundamentals(
    freqData: Uint8Array,
    sampleRate: number,
    fftSize: number,
    a4Hz: number
): Map<number, number> {
    const binHz = sampleRate / fftSize;
    const detected = new Map<number, number>();

    // Scan bass range: A0 (MIDI 21) to C3 (MIDI 48)
    for (let midiNote = 21; midiNote <= 48; midiNote++) {
        const fundamentalFreq = midiToFreq(midiNote, a4Hz);

        // Check harmonics 2f through 8f (skip 1f since it's likely missing)
        // Weight higher harmonics less (they're naturally weaker)
        let harmonicScore = 0;
        let harmonicsFound = 0;

        for (let harmonic = 2; harmonic <= 8; harmonic++) {
            const harmonicFreq = fundamentalFreq * harmonic;
            if (harmonicFreq > 4200) break; // Outside piano range

            const bin = Math.round(harmonicFreq / binHz);
            if (bin < freqData.length) {
                const energy = freqData[bin];
                if (energy > 15) { // Ignore noise floor
                    // Weight: 1/harmonic (2f gets weight 0.5, 3f gets 0.33, etc.)
                    harmonicScore += energy / harmonic;
                    harmonicsFound++;
                }
            }
        }

        // Require at least 3 harmonics to avoid false positives
        // Average score must be > 25 (after weighting) to be significant
        if (harmonicsFound >= 3 && harmonicScore / harmonicsFound > 25) {
            // Reconstruct the fundamental with confidence proportional to harmonic strength
            // Cap at 200 to avoid overwhelming direct fundamentals in treble register
            const reconstructedEnergy = Math.min(harmonicScore, 200);
            detected.set(midiNote, reconstructedEnergy);
        }
    }

    return detected;
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
    // Chord template matching state
    const recentCandidatesRef    = useRef<number[]>([]); // sliding-window vote buffer (−1 = no chord)
    const activeChordRef         = useRef(-1);  // index of currently reported chord (−1 = none)
    const prevRawMaxRef          = useRef(0);   // raw chroma max of previous tick (onset detection)
    const lastActivationTimeRef   = useRef(0);   // Date.now() when the displayed chord last changed
    const lastConfirmedTickRef    = useRef(0);   // Date.now() of last tick where active chord still won

    // ── stop ─────────────────────────────────────────────────────────────────

    const stop = useCallback(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        streamRef.current?.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close();

        intervalRef.current = null;
        streamRef.current   = null;
        audioCtxRef.current = null;
        analyserRef.current = null;
        isActiveRef.current         = false;
        recentCandidatesRef.current  = [];
        activeChordRef.current       = -1;
        prevRawMaxRef.current        = 0;
        lastActivationTimeRef.current  = 0;
        lastConfirmedTickRef.current   = 0;

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
            // Minimal browser-side smoothing: a lower value lets the FFT energy drop
            // quickly after key release so that raw-energy-based deactivation responds
            // within ~150 ms instead of 400–600 ms (especially important on Android,
            // where timer intervals are ~100 ms rather than the nominal 50 ms).
            // Chord-detection noise is handled by the score gates and stability voting,
            // so a low smoothingTimeConstant here does not hurt recognition quality.
            analyser.smoothingTimeConstant = 0.2;
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

            // console.log(
            //     `[ChromaDetection] AudioContext SR: ${ctx.sampleRate} Hz` +
            //     ` | FFT bins: ${analyser.frequencyBinCount}` +
            //     ` | bins per PC: [${binsPerPc.join(', ')}]`
            // );

            setStatus('active');

            // 4. Periodic chroma analysis
            const freqData = new Uint8Array(analyser.frequencyBinCount);

            intervalRef.current = setInterval(() => {
                const an = analyserRef.current;
                if (!an) return;
                an.getByteFrequencyData(freqData);

                // ── Phase 1: Standard chroma from FFT bins ────────────────────
                const chromaSum = new Array(12).fill(0);
                for (let i = 0; i < freqData.length; i++) {
                    const pc = binToPc[i];
                    if (pc !== null) chromaSum[pc] += freqData[i];
                }
                const chroma = chromaSum.map((s, pc) =>
                    binsPerPc[pc] > 0 ? s / binsPerPc[pc] : 0
                );

                // ── Phase 2: Add reconstructed bass fundamentals ──────────────
                // Detect missing fundamentals from harmonic series (e.g., C2 from its
                // overtones at 130, 195, 260 Hz even when 65 Hz fundamental is inaudible)
                const missingFundamentals = detectMissingFundamentals(
                    freqData,
                    ctx.sampleRate,
                    FFT_SIZE,
                    a4Hz
                );

                // Add reconstructed notes to chroma vector
                // Weight them equally to direct detections since they represent
                // psychoacoustically perceived pitch (your ears hear them as fundamentals)
                for (const [midiNote, energy] of missingFundamentals) {
                    const pitchClass = midiNote % 12;
                    // Average the reconstructed energy with existing chroma value
                    // This prevents double-counting if fundamental was actually present
                    chroma[pitchClass] = Math.max(chroma[pitchClass], energy);
                }

                // Debug: Log reconstructed bass fundamentals (uncomment to debug)
                // if (missingFundamentals.size > 0) {
                //     const notes = Array.from(missingFundamentals.entries())
                //         .map(([midi, energy]) => `${NOTE_NAMES[midi % 12]}${Math.floor(midi / 12) - 1}(${energy.toFixed(0)})`)
                //         .join(', ');
                //     console.log(`[MissingFundamental] Reconstructed: ${notes}`);
                // }

                // ── Onset detection ───────────────────────────────────────────────────
                // When raw chroma max jumps by ONSET_RATIO in one tick, a new chord
                // onset is assumed. Flush the vote window so that decaying strings from
                // the previously-released chord do not score into the new chord's
                // template matches.
                // The active chord ref is deliberately NOT cleared here: the display
                // continues showing the old chord until the new chord has accumulated
                // CANDIDATE_MIN_WINS confirmed consecutive ticks.
                const rawMax = Math.max(...chroma);
                if (rawMax > prevRawMaxRef.current * ONSET_RATIO && rawMax >= MIN_PEAK_ENERGY) {
                    recentCandidatesRef.current = [];
                }
                prevRawMaxRef.current = rawMax;

                // ── Chord template matching ───────────────────────────────────
                // Score each chord: average normalised energy of its 3 notes.
                // Naturally handles harmonic bleed: a chord requires ALL 3 notes
                // to be strong — a single harmonic cannot push a wrong chord above threshold.
                let bestIdx   = -1;
                let bestScore = 0;

                if (rawMax >= MIN_PEAK_ENERGY) {
                    for (let i = 0; i < CHORD_TEMPLATES.length; i++) {
                        const score =
                            CHORD_TEMPLATES[i].notes.reduce((s, pc) => s + chroma[pc], 0) /
                            (CHORD_TEMPLATES[i].notes.length * rawMax);
                        if (score > bestScore) { bestScore = score; bestIdx = i; }
                    }
                    if (bestScore < CHORD_MIN_SCORE) bestIdx = -1;
                }

                // ── Sliding-window stability vote ─────────────────────────────
                // Push this tick's best candidate into the rolling window.
                // A chord is activated / switched-to only when it appears in
                // CANDIDATE_MIN_WINS *consecutive* ticks at the tail of the window.
                // This prevents attack transients (which last 1–3 ticks) from ever
                // accumulating enough wins to trigger a spurious key change.
                recentCandidatesRef.current.push(bestIdx);
                if (recentCandidatesRef.current.length > CANDIDATE_WINDOW_SIZE) {
                    recentCandidatesRef.current.shift();
                }

                // Count consecutive wins of bestIdx at the tail of the vote window.
                const cands = recentCandidatesRef.current;
                let consecutiveTail = 0;
                if (bestIdx !== -1) {
                    for (let i = cands.length - 1; i >= 0; i--) {
                        if (cands[i] === bestIdx) consecutiveTail++;
                        else break;
                    }
                }
                // ── Score gate: three gating rules ────────────────────────────
                //  A) Confirmation — same chord as currently active: a single tick
                //     with score ≥ CHORD_MIN_SCORE suffices. No window run required
                //     so a momentary score dip cannot cause a premature CLEAR.
                //  B) Fresh activation — no chord active: require CANDIDATE_MIN_WINS
                //     consecutive wins to avoid reacting to transients.
                //  C) Switch — different chord while one is active: same run length
                //     but stricter CHORD_SWITCH_SCORE blocks attack-noise artefacts.
                let dominantIdx = -1;
                if (bestIdx !== -1) {
                    if (bestIdx === activeChordRef.current) {
                        // A) Confirmation of active chord — single tick, relaxed threshold.
                        if (bestScore >= CHORD_MIN_SCORE) dominantIdx = bestIdx;
                    } else if (consecutiveTail >= CANDIDATE_MIN_WINS) {
                        // B) Fresh activation or C) chord switch.
                        const activateThreshold =
                            activeChordRef.current === -1 ? CHORD_MIN_SCORE : CHORD_SWITCH_SCORE;
                        if (bestScore >= activateThreshold) dominantIdx = bestIdx;
                    }
                }

                // ── Activate / switch ─────────────────────────────────────────
                // Gate 1 (score + consecutive wins): handled above via dominantIdx.
                // Gate 2 (minimum hold time): the current chord must have been visible
                //   for at least MIN_HOLD_MS before it can be replaced. This bounds the
                //   display update rate to the musician's actual playing tempo and prevents
                //   any transient from appearing and vanishing within a fraction of a second.
                //   First activation from silence (activeChordRef === −1) is not gated.
                const heldLongEnough =
                    activeChordRef.current === -1 ||
                    (Date.now() - lastActivationTimeRef.current) >= MIN_HOLD_MS;

                if (dominantIdx !== -1 && dominantIdx !== activeChordRef.current && heldLongEnough) {
                    const tmpl = CHORD_TEMPLATES[dominantIdx];
                    activeChordRef.current = dominantIdx;
                    lastActivationTimeRef.current = Date.now();
                    lastConfirmedTickRef.current  = Date.now();
                    setPressedNotes(new Set(tmpl.midiNotes));
                    // console.log(
                    //     `%c[ChordDet] ACTIVATE ${tmpl.label}` +
                    //     ` | score=${bestScore.toFixed(2)}` +
                    //     ` | wins=${consecutiveTail}`,
                    //     'color:#22c55e;font-weight:bold'
                    // );
                }

                // Refresh the confirmation timestamp while the active chord keeps winning.
                // As soon as the player releases the keys the consecutive-win run breaks,
                // dominantIdx falls back to −1, and this branch stops executing — starting
                // the DEACTIVATE_INACTIVITY_MS countdown below.
                if (dominantIdx !== -1 && dominantIdx === activeChordRef.current) {
                    lastConfirmedTickRef.current = Date.now();
                }

                // ── Deactivate ────────────────────────────────────────────────
                // Clear the display once no tick has confirmed the active chord for
                // DEACTIVATE_INACTIVITY_MS. This is immune to room reverb and piano
                // string resonance: it measures elapsed wall-clock time since the last
                // vote confirmation, not absolute energy levels.
                // Also resets the hold timer so the next chord activates immediately.
                if (activeChordRef.current !== -1 &&
                    (Date.now() - lastConfirmedTickRef.current) >= DEACTIVATE_INACTIVITY_MS) {
                    // const msHeld = Date.now() - lastActivationTimeRef.current;
                    // console.log(
                    //     `%c[ChordDet] CLEAR` +
                    //     ` | shown for ${msHeld} ms` +
                    //     ` | inactivity=${Date.now() - lastConfirmedTickRef.current} ms`,
                    //     'color:#f87171;font-weight:bold'
                    // );
                    activeChordRef.current = -1;
                    lastActivationTimeRef.current = 0;
                    // Flush the voting window so re-activation after silence requires
                    // a fresh run of CANDIDATE_MIN_WINS consecutive wins, not stale votes.
                    recentCandidatesRef.current = [];
                    setPressedNotes(new Set());
                }

                // ── Per-tick debug log ────────────────────────────────────────
                // if (rawMax >= MIN_PEAK_ENERGY || activeChordRef.current >= 0) {
                //     const activeLabel  = activeChordRef.current >= 0
                //         ? CHORD_TEMPLATES[activeChordRef.current].label : '—';
                //     const bestLabel    = bestIdx >= 0 ? CHORD_TEMPLATES[bestIdx].label : '—';
                //     const domLabel     = dominantIdx >= 0 ? CHORD_TEMPLATES[dominantIdx].label : '—';
                //     const msSinceConf  = activeChordRef.current >= 0
                //         ? Date.now() - lastConfirmedTickRef.current : 0;
                //     console.log(
                //         `[ChordDet] tick` +
                //         ` | rawMax=${rawMax.toFixed(1)}` +
                //         ` | best=${bestLabel}(${bestScore.toFixed(2)})` +
                //         ` | tail=${consecutiveTail}` +
                //         ` | dom=${domLabel}` +
                //         ` | active=${activeLabel}` +
                //         ` | msNoConf=${msSinceConf}`
                //     );
                // }

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
