/**
 * Tuning calibration hook.
 *
 * The user plays the A note on their instrument (any octave).
 * The algorithm detects the dominant peak frequency, folds it into the A4
 * octave range and stores it directly as the A4 reference.
 *
 * Examples:
 *   User plays A3 (210 Hz on a 420 Hz instrument) → folded to A4 = 420 Hz
 *   User plays A4 (500 Hz on a 500 Hz instrument) → stored as 500 Hz
 *   User plays A5 (880 Hz on a 440 Hz instrument) → folded to A4 = 440 Hz
 *
 * The result is persisted in a cookie (cof-a4-hz) and picked up by
 * useChromaDetection on the next start() call.
 */

import { useCallback, useRef, useState } from 'react';

// ── Constants ────────────────────────────────────────────────────────────────

const FFT_SIZE = 8192;
const CALIBRATION_DURATION_MS = 3000;
const TICK_INTERVAL_MS = 50;

/** Minimum absolute FFT bin energy (0–255) for the peak to be considered. */
const MIN_SIGNAL_ENERGY = 60;

/**
 * The peak bin must be at least this many times higher than the mean energy
 * of all bins in the analysis range. This rejects broadband noise where
 * many bins are elevated but no single frequency dominates.
 */
const MIN_SNR_RATIO = 5;

/**
 * Accepted range for the A4 reference after octave-folding.
 * Wide enough to cover baroque pitch (A = 390 Hz) through very high tuning
 * (A = 500 Hz), while excluding octave-fold ambiguity at the boundaries.
 */
const A4_MIN = 350;
const A4_MAX = 550;

/** Minimum number of valid samples required for a successful calibration. */
const MIN_SAMPLES = 5;

// ── Cookie helpers ───────────────────────────────────────────────────────────

export const A4_COOKIE_KEY   = 'cof-a4-hz';
export const DEFAULT_A4_HZ   = 440;

export function readA4Hz(): number {
    const match = document.cookie.match(/(?:^|;\s*)cof-a4-hz=([^;]+)/);
    if (!match) return DEFAULT_A4_HZ;
    const val = parseFloat(match[1]);
    return isNaN(val) || val < A4_MIN || val > A4_MAX ? DEFAULT_A4_HZ : val;
}

export function writeA4Hz(hz: number): void {
    const exp = new Date();
    exp.setFullYear(exp.getFullYear() + 10);
    document.cookie =
        `${A4_COOKIE_KEY}=${hz.toFixed(2)};expires=${exp.toUTCString()};path=/;SameSite=Lax`;
}

export function resetA4Hz(): void {
    document.cookie =
        `${A4_COOKIE_KEY}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/;SameSite=Lax`;
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Folds a detected frequency into the A4 octave by doubling or halving.
 * The user must play A (any octave); this collapses it to the A4 range.
 * Returns null for values outside [A4_MIN, A4_MAX] even after folding
 * (e.g. noise spikes below 20 Hz or above 20 kHz).
 */
function foldToA4Range(freq: number): number | null {
    if (freq <= 0 || !isFinite(freq)) return null;
    let f = freq;
    while (f < A4_MIN) f *= 2;
    while (f > A4_MAX) f /= 2;
    if (f < A4_MIN || f > A4_MAX) return null;
    return f;
}

/**
 * Finds the FFT bin with the highest energy in the 80–2000 Hz range and
 * refines its position using parabolic interpolation.
 * Returns null when no bin exceeds MIN_SIGNAL_ENERGY.
 */
function findPeakFrequency(
    freqData: Uint8Array,
    sampleRate: number,
    fftSize: number,
): number | null {
    const binHz  = sampleRate / fftSize;
    const minBin = Math.max(1,                    Math.round(80   / binHz));
    const maxBin = Math.min(freqData.length - 2,  Math.round(2000 / binHz));

    let maxEnergy = 0;
    let peakBin   = -1;
    let sumEnergy = 0;
    const binCount = maxBin - minBin + 1;

    for (let i = minBin; i <= maxBin; i++) {
        sumEnergy += freqData[i];
        if (freqData[i] > maxEnergy) { maxEnergy = freqData[i]; peakBin = i; }
    }
    if (peakBin === -1 || maxEnergy < MIN_SIGNAL_ENERGY) return null;

    // SNR check: peak must stand out clearly above the mean noise floor
    const meanEnergy = sumEnergy / binCount;
    if (meanEnergy === 0 || maxEnergy / meanEnergy < MIN_SNR_RATIO) return null;

    // Parabolic interpolation for sub-bin frequency accuracy
    let refined = peakBin;
    const a = freqData[peakBin - 1];
    const b = freqData[peakBin];
    const c = freqData[peakBin + 1];
    const denom = a - 2 * b + c;
    if (denom !== 0) refined = peakBin + 0.5 * (a - c) / denom;

    return refined * binHz;
}

// ── Types ────────────────────────────────────────────────────────────────────

export type CalibrationStatus = 'idle' | 'listening' | 'done' | 'error';

export interface CalibrationResult {
    status:     CalibrationStatus;
    /** Measured A4 frequency in Hz, only set when status === 'done'. */
    measuredHz: number | null;
    /** Measurement progress 0→1. */
    progress:   number;
    start:  () => Promise<void>;
    cancel: () => void;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useTuningCalibration(): CalibrationResult {
    const [status,     setStatus]     = useState<CalibrationStatus>('idle');
    const [measuredHz, setMeasuredHz] = useState<number | null>(null);
    const [progress,   setProgress]   = useState(0);

    const audioCtxRef  = useRef<AudioContext | null>(null);
    const streamRef    = useRef<MediaStream | null>(null);
    const intervalRef  = useRef<ReturnType<typeof setInterval> | null>(null);
    const samplesRef   = useRef<number[]>([]);
    const startTimeRef = useRef(0);
    const cancelledRef = useRef(false);

    // ── cleanup ───────────────────────────────────────────────────────────────

    const cleanup = useCallback(() => {
        if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
        streamRef.current?.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close().catch(() => {});
        streamRef.current   = null;
        audioCtxRef.current = null;
    }, []);

    // ── cancel ────────────────────────────────────────────────────────────────

    const cancel = useCallback(() => {
        cancelledRef.current = true;
        cleanup();
        setStatus('idle');
        setProgress(0);
        setMeasuredHz(null);
    }, [cleanup]);

    // ── start ─────────────────────────────────────────────────────────────────

    const start = useCallback(async () => {
        cancelledRef.current = false;
        samplesRef.current   = [];
        setStatus('listening');
        setMeasuredHz(null);
        setProgress(0);

        try {
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
                video: false,
            });
            if (cancelledRef.current) { stream.getTracks().forEach(t => t.stop()); return; }
            streamRef.current = stream;

            const AudioCtorRaw =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioCtorRaw();
            await ctx.resume();
            if (cancelledRef.current) { ctx.close(); stream.getTracks().forEach(t => t.stop()); return; }
            audioCtxRef.current = ctx;

            const analyser = ctx.createAnalyser();
            analyser.fftSize               = FFT_SIZE;
            analyser.smoothingTimeConstant = 0.3;
            ctx.createMediaStreamSource(stream).connect(analyser);

            const freqData     = new Uint8Array(analyser.frequencyBinCount);
            startTimeRef.current = performance.now();

            intervalRef.current = setInterval(() => {
                if (cancelledRef.current) return;

                const elapsed = performance.now() - startTimeRef.current;
                setProgress(Math.min(1, elapsed / CALIBRATION_DURATION_MS));

                analyser.getByteFrequencyData(freqData);
                const peak = findPeakFrequency(freqData, ctx.sampleRate, FFT_SIZE);
                if (peak !== null) {
                    const a4 = foldToA4Range(peak);
                    if (a4 !== null) samplesRef.current.push(a4);
                }

                if (elapsed >= CALIBRATION_DURATION_MS) {
                    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null; }
                    cleanup();

                    if (samplesRef.current.length < MIN_SAMPLES) {
                        setStatus('error');
                        setProgress(0);
                        return;
                    }
                    const sorted = [...samplesRef.current].sort((a, b) => a - b);
                    const median = sorted[Math.floor(sorted.length / 2)];
                    setMeasuredHz(median);
                    setStatus('done');
                    setProgress(0);
                }
            }, TICK_INTERVAL_MS);

        } catch {
            if (!cancelledRef.current) setStatus('error');
            cleanup();
        }
    }, [cleanup]);

    return { status, measuredHz, progress, start, cancel };
}
