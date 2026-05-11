/**
 * Tuning calibration hook.
 *
 * Listens to the microphone for CALIBRATION_DURATION_MS milliseconds,
 * finds the dominant peak frequency, octave-folds it into the A4 range
 * (400–480 Hz) and returns the median as the measured concert-A reference.
 *
 * The result is persisted in a cookie (cof-a4-hz) and picked up by
 * useChromaDetection on the next start() call.
 */

import { useCallback, useRef, useState } from 'react';

// ── Constants ────────────────────────────────────────────────────────────────

const FFT_SIZE = 8192;
const CALIBRATION_DURATION_MS = 3000;
const TICK_INTERVAL_MS = 50;

/** Minimum FFT bin energy (0–255) to consider a peak valid. */
const MIN_SIGNAL_ENERGY = 30;

/** Octave-folding target range for A4 (covers 415 Hz Baroque to 466 Hz). */
const A4_FOLD_LOW  = 400;
const A4_FOLD_HIGH = 480;

/** Minimum number of valid samples required for a successful calibration. */
const MIN_SAMPLES = 5;

// ── Cookie helpers ───────────────────────────────────────────────────────────

export const A4_COOKIE_KEY   = 'cof-a4-hz';
export const DEFAULT_A4_HZ   = 440;

export function readA4Hz(): number {
    const match = document.cookie.match(/(?:^|;\s*)cof-a4-hz=([^;]+)/);
    if (!match) return DEFAULT_A4_HZ;
    const val = parseFloat(match[1]);
    return isNaN(val) || val < A4_FOLD_LOW || val > A4_FOLD_HIGH ? DEFAULT_A4_HZ : val;
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
 * Folds a frequency into the A4 calibration range by doubling/halving octaves.
 * Returns null if the frequency cannot be folded into range
 * (e.g. extremely low noise spikes).
 */
function foldToA4Range(freq: number): number | null {
    let f = freq;
    // Avoid infinite loops for silence / garbage values
    if (f <= 0 || !isFinite(f)) return null;
    while (f < A4_FOLD_LOW) f *= 2;
    while (f > A4_FOLD_HIGH) f /= 2;
    if (f < A4_FOLD_LOW || f > A4_FOLD_HIGH) return null;
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
    for (let i = minBin; i <= maxBin; i++) {
        if (freqData[i] > maxEnergy) { maxEnergy = freqData[i]; peakBin = i; }
    }
    if (peakBin === -1 || maxEnergy < MIN_SIGNAL_ENERGY) return null;

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
                    const folded = foldToA4Range(peak);
                    if (folded !== null) samplesRef.current.push(folded);
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
