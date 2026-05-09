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
 * Number of trailing output frames to average when deciding which notes are
 * "currently active".  ~400 ms worth of audio.
 */
const ACTIVE_FRAMES = Math.round((0.4 * BP_SAMPLE_RATE) / HOP_SIZE); // ≈ 34

/** Per-note frame-probability threshold above which a note is considered active. */
const FRAME_THRESHOLD = 0.5;

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

                    if (frames.length === 0) return;

                    // Average the last ACTIVE_FRAMES and threshold per note
                    const fromFrame   = Math.max(0, frames.length - ACTIVE_FRAMES);
                    const frameCount  = frames.length - fromFrame;
                    const activeNotes = new Set<number>();

                    for (let noteIdx = 0; noteIdx < 88; noteIdx++) {
                        let sum = 0;
                        for (let fi = fromFrame; fi < frames.length; fi++) {
                            sum += frames[fi][noteIdx] ?? 0;
                        }
                        if (sum / frameCount >= FRAME_THRESHOLD) {
                            activeNotes.add(MIDI_OFFSET + noteIdx);
                        }
                    }

                    setPressedNotes(activeNotes);
                } catch {
                    // Inference errors are non-fatal – skip this cycle silently.
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
