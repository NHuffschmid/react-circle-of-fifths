// This file uses Basic Pitch (https://github.com/spotify/basic-pitch) for
// real-time audio-to-MIDI conversion.  Basic Pitch is licensed under the
// Apache License 2.0 – see LICENSE_BASIC_PITCH.md in the repository root.

import { useCallback, useRef, useState } from 'react';
import type { PitchDetectionResult, PitchDetectionStatus } from './PitchDetectionTypes';

// ── Constants ────────────────────────────────────────────────────────────────

/** CDN URL for the Basic Pitch TensorFlow.js model (same version as the main app). */
const MODEL_URL = 'https://unpkg.com/@spotify/basic-pitch@1.0.1/model/model.json';

/** Sample rate (Hz) expected by Basic Pitch. */
const BP_SAMPLE_RATE = 22050;

/** Sliding audio window fed to the model on each inference cycle (seconds). */
const WINDOW_SECONDS = 2;
const WINDOW_SAMPLES = BP_SAMPLE_RATE * WINDOW_SECONDS; // 44 100

/**
 * Basic Pitch hop size in samples.  At 22 050 Hz each output frame represents
 * 256 / 22 050 ≈ 11.6 ms of audio.
 */
const HOP_SIZE = 256;

/**
 * Number of trailing output frames to scan for active notes (~1 second).
 * A note must appear above FRAME_THRESHOLD in at least MIN_FRAME_COUNT frames
 * within this window to be considered active.
 */
const ACTIVE_FRAMES = Math.round((1.0 * BP_SAMPLE_RATE) / HOP_SIZE); // ≈ 86

/** Per-note frame-probability threshold to count a frame as "note present". */
const FRAME_THRESHOLD = 0.30;

/**
 * Minimum number of frames (within the ACTIVE_FRAMES window) that must exceed
 * FRAME_THRESHOLD before a note is considered active.
 * Filters single-frame artifacts while still catching short note presses.
 */
const MIN_FRAME_COUNT = 2;

/** Interval (ms) between successive inference runs. */
const INFERENCE_INTERVAL_MS = 350;

/**
 * MIDI number of the lowest piano key (A0 = 21).
 * Basic Pitch outputs one value per piano key in ascending order.
 */
const MIDI_OFFSET = 21;

/** Size of the ScriptProcessorNode audio buffer (must be a power of 2). */
const SCRIPT_BUFFER_SIZE = 4096;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Resample a mono Float32 PCM array from srcRate to BP_SAMPLE_RATE (22 050 Hz)
 * using linear interpolation.
 */
function resampleToTarget(input: Float32Array, srcRate: number): Float32Array {
    if (srcRate === BP_SAMPLE_RATE) return input;
    const ratio = srcRate / BP_SAMPLE_RATE;
    const outLen = Math.floor(input.length / ratio);
    const out = new Float32Array(outLen);
    for (let i = 0; i < outLen; i++) {
        const pos = i * ratio;
        const lo = Math.floor(pos);
        const hi = Math.min(lo + 1, input.length - 1);
        out[i] = input[lo] + (input[hi] - input[lo]) * (pos - lo);
    }
    return out;
}

// ── Hook ─────────────────────────────────────────────────────────────────────

/**
 * Pitch-detection adapter built on @spotify/basic-pitch.
 *
 * Pipeline:
 *   getUserMedia → ScriptProcessorNode → resample to 22 050 Hz → ring buffer
 *   → every INFERENCE_INTERVAL_MS: snapshot → BasicPitch.evaluateModel()
 *   → average last ACTIVE_FRAMES → threshold → Set<midiNote>
 */
export function useBasicPitchDetection(): PitchDetectionResult {
    const [status, setStatus] = useState<PitchDetectionStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [pressedNotes, setPressedNotes] = useState<Set<number>>(new Set());

    // ── Persistent refs (survive re-renders, don't trigger them) ────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const basicPitchRef = useRef<any>(null);       // BasicPitch instance (loaded once)
    const audioCtxRef   = useRef<AudioContext | null>(null);
    const streamRef     = useRef<MediaStream | null>(null);
    const processorRef  = useRef<ScriptProcessorNode | null>(null);
    const ringBufRef    = useRef<Float32Array>(new Float32Array(WINDOW_SAMPLES));
    const writeIdxRef   = useRef(0);               // total samples written (unbounded)
    const intervalRef   = useRef<ReturnType<typeof setInterval> | null>(null);
    const inferRunRef   = useRef(false);            // guard against overlapping inferences
    const isActiveRef   = useRef(false);            // guard against double-start
    const logCountRef   = useRef(0);                // throttle mic-level logs

    // ── stop ─────────────────────────────────────────────────────────────────

    const stop = useCallback(() => {
        if (intervalRef.current) clearInterval(intervalRef.current);
        processorRef.current?.disconnect();
        streamRef.current?.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close();

        intervalRef.current = null;
        processorRef.current = null;
        streamRef.current = null;
        audioCtxRef.current = null;
        inferRunRef.current = false;
        isActiveRef.current = false;

        setPressedNotes(new Set());
        setStatus('idle');
    }, []);

    // ── start ─────────────────────────────────────────────────────────────────

    const start = useCallback(async () => {
        if (isActiveRef.current) return;
        isActiveRef.current = true;

        setStatus('requesting');
        setErrorMessage(null);
        setPressedNotes(new Set());

        try {
            // 1. Request microphone permission
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl: false,
                },
                video: false,
            });
            streamRef.current = stream;

            setStatus('loading');

            // 2. Lazy-load Basic Pitch model (singleton – only fetched once per session)
            if (!basicPitchRef.current) {
                const { BasicPitch } = await import('@spotify/basic-pitch');
                basicPitchRef.current = new BasicPitch(MODEL_URL);
            }

            // 3. Build Web Audio pipeline
            //    Prefer explicit 22050 Hz context; fall back to browser default.
            const AudioCtorRaw =
                window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioCtorRaw();
            await ctx.resume(); // required after a user-gesture on mobile
            audioCtxRef.current = ctx;

            const nativeSR = ctx.sampleRate;
            console.log(`[PitchDetection] AudioContext sample rate: ${nativeSR} Hz`);
            const source   = ctx.createMediaStreamSource(stream);
            const processor = ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
            processorRef.current = processor;

            // Reset ring buffer
            ringBufRef.current.fill(0);
            writeIdxRef.current = 0;

            processor.onaudioprocess = (ev: AudioProcessingEvent) => {
                const raw      = ev.inputBuffer.getChannelData(0);
                const samples  = resampleToTarget(Float32Array.from(raw), nativeSR);
                for (let i = 0; i < samples.length; i++) {
                    ringBufRef.current[writeIdxRef.current % WINDOW_SAMPLES] = samples[i];
                    writeIdxRef.current++;
                }
                // Log mic RMS every ~2 seconds to verify audio capture
                logCountRef.current++;
                if (logCountRef.current % 43 === 0) { // ~2 s at 48 kHz / 4096 buffer
                    let sumSq = 0;
                    for (let i = 0; i < raw.length; i++) sumSq += raw[i] * raw[i];
                    const rms = Math.sqrt(sumSq / raw.length);
                    const filled = Math.min(writeIdxRef.current, WINDOW_SAMPLES);
                    console.log(
                        `[PitchDetection] Mic RMS: ${rms.toFixed(4)}` +
                        ` | buffer filled: ${filled}/${WINDOW_SAMPLES} samples` +
                        ` (${((filled / WINDOW_SAMPLES) * 100).toFixed(0)}%)`
                    );
                }
            };

            // Connect through a silent gain node so the processor fires without
            // routing microphone audio to the speakers.
            const silentGain = ctx.createGain();
            silentGain.gain.value = 0;
            source.connect(processor);
            processor.connect(silentGain);
            silentGain.connect(ctx.destination);

            setStatus('active');

            // 4. Periodic inference
            intervalRef.current = setInterval(async () => {
                if (inferRunRef.current || !audioCtxRef.current || !basicPitchRef.current) return;
                inferRunRef.current = true;
                const t0 = performance.now();
                const samplesWritten = writeIdxRef.current;
                // How many samples are real audio vs. initial zeros
                const realSamples = Math.min(samplesWritten, WINDOW_SAMPLES);
                console.log(
                    `[PitchDetection] Inference start | audio in buffer: ` +
                    `${realSamples}/${WINDOW_SAMPLES} samples ` +
                    `(${((realSamples / WINDOW_SAMPLES) * 100).toFixed(0)}%)`
                );
                try {
                    // Reconstruct ring buffer in chronological order
                    const snapshot   = new Float32Array(WINDOW_SAMPLES);
                    const ringStart  = writeIdxRef.current % WINDOW_SAMPLES;
                    for (let i = 0; i < WINDOW_SAMPLES; i++) {
                        snapshot[i] = ringBufRef.current[(ringStart + i) % WINDOW_SAMPLES];
                    }

                    const audioBuffer = audioCtxRef.current.createBuffer(
                        1, WINDOW_SAMPLES, BP_SAMPLE_RATE,
                    );
                    audioBuffer.getChannelData(0).set(snapshot);

                    const frames: number[][] = [];
                    await basicPitchRef.current.evaluateModel(
                        audioBuffer,
                        (f: number[][], _o: number[][], _c: number[][]) => {
                            frames.push(...f);
                        },
                        () => {}, // suppress progress callback
                    );

                    const inferMs = (performance.now() - t0).toFixed(0);
                    if (frames.length === 0) {
                        console.log(`[PitchDetection] Inference done in ${inferMs} ms | 0 frames returned`);
                        return;
                    }

                    // Count frames above threshold per note within the last ACTIVE_FRAMES
                    // (note must appear in >= MIN_FRAME_COUNT frames to be considered active)
                    const fromFrame   = Math.max(0, frames.length - ACTIVE_FRAMES);
                    const activeNotes = new Set<number>();
                    let maxProb = 0;

                    for (let noteIdx = 0; noteIdx < 88; noteIdx++) {
                        let count = 0;
                        for (let fi = fromFrame; fi < frames.length; fi++) {
                            const p = frames[fi][noteIdx] ?? 0;
                            if (p > maxProb) maxProb = p;
                            if (p >= FRAME_THRESHOLD) count++;
                        }
                        if (count >= MIN_FRAME_COUNT) {
                            activeNotes.add(MIDI_OFFSET + noteIdx);
                        }
                    }

                    console.log(
                        `[PitchDetection] Inference done in ${inferMs} ms` +
                        ` | frames: ${frames.length} (eval: ${fromFrame}–${frames.length})` +
                        ` | maxProb: ${maxProb.toFixed(3)}` +
                        ` | active MIDI notes: [${[...activeNotes].join(', ')}]`
                    );

                    setPressedNotes(activeNotes);
                } catch (err) {
                    console.error('[PitchDetection] Inference error:', err);
                } finally {
                    inferRunRef.current = false;
                }
            }, INFERENCE_INTERVAL_MS);

        } catch (err: unknown) {
            isActiveRef.current = false;
            setStatus('error');
            const domErr = err as DOMException | Error;
            const msg = domErr?.name === 'NotAllowedError' || domErr?.name === 'PermissionDeniedError'
                ? 'Microphone access denied. Please allow microphone access and try again.'
                : (domErr?.message ?? 'An unknown error occurred.');
            setErrorMessage(msg);
        }
    }, []); // no deps – all mutable state lives in refs

    return { status, errorMessage, pressedNotes, start, stop };
}
