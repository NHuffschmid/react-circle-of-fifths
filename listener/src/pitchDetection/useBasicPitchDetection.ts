/**
 * BasicPitch-based real-time polyphonic note detection using the Web Audio API
 * and the @spotify/basic-pitch neural-network model.
 *
 * Pipeline:
 *   getUserMedia → ScriptProcessorNode (ring buffer) → resample to 22 050 Hz
 *   → BasicPitch model (TF.js) → NoteEventTime[] → Set<midiNote>
 *
 * Advantages over the FFT-chroma engine:
 *  • Detects individual piano notes (full 88-key range), not only triads.
 *  • Handles polyphony correctly — all simultaneously pressed keys are reported.
 *  • No explicit chord templates needed; trained on real piano audio.
 *
 * Latency: ~400–600 ms (STEP_MS buffering + model inference + OfflineAudioContext
 * resampling). The first analysis takes longer while TF.js JIT-compiles the graph.
 */

import { useCallback, useRef, useState } from 'react';
import {
    BasicPitch,
    addPitchBendsToNoteEvents,
    noteFramesToTime,
    outputToNotesPoly,
} from '@spotify/basic-pitch';
import type { PitchDetectionResult, PitchDetectionStatus } from './PitchDetectionTypes';

// ── Constants ─────────────────────────────────────────────────────────────────

/** Sample rate expected by the BasicPitch model (fixed, do not change). */
const BP_SAMPLE_RATE = 22_050;

/**
 * Model files are served from public/basic-pitch-model/ (copied by postinstall).
 * import.meta.env.BASE_URL reflects the Vite `base` option so the path is correct
 * regardless of whether the app is hosted at / or a sub-path like /react-circle-of-fifths/.
 */
const MODEL_URL = `${import.meta.env.BASE_URL}basic-pitch-model/model.json`;

/**
 * Length of the rolling audio buffer that is analysed on each tick (seconds).
 * Smaller windows improve responsiveness and reduce inference cost, but if this
 * gets too short polyphonic note estimates become unstable.
 */
const BUFFER_SEC = 0.9;

/**
 * How often the analysis loop runs (milliseconds).
 * Lower values improve responsiveness as long as inference time stays below the
 * tick interval.
 */
const STEP_MS = 120;

/** BasicPitch onset detection threshold (0–1). Raise to reduce false onsets. */
const ONSET_THR = 0.3;

/** BasicPitch frame activation threshold (0–1). Raise to suppress soft / ghost notes. */
const FRAME_THR = 0.25;

/** Minimum note duration in model frames (~23 ms/frame at 22 050 Hz / 512 hop). */
const MIN_NOTE_FRAMES = 3;

/** Minimum amount of buffered audio required before the first inference starts. */
const MIN_ANALYSIS_SEC = 0.35;

/**
 * A note is considered "currently active" when its end time falls within the last
 * NOTE_ACTIVE_WINDOW_S seconds of the analysed buffer.
 * Increase if notes are dropping out too early; decrease to react faster to release.
 */
const NOTE_ACTIVE_WINDOW_S = 0.25;

// ── Hook ─────────────────────────────────────────────────────────────────────

export function useBasicPitchDetection(): PitchDetectionResult {
    const [status, setStatus]             = useState<PitchDetectionStatus>('idle');
    const [errorMessage, setErrorMessage] = useState<string | null>(null);
    const [pressedNotes, setPressedNotes] = useState<Set<number>>(new Set());

    const audioCtxRef    = useRef<AudioContext | null>(null);
    const streamRef      = useRef<MediaStream | null>(null);
    const processorRef   = useRef<ScriptProcessorNode | null>(null);
    const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
    const basicPitchRef  = useRef<BasicPitch | null>(null);
    const samplesRef     = useRef<Float32Array[]>([]);
    const isActiveRef    = useRef(false);
    /** Prevents a new analysis tick from starting while the previous one is still running. */
    const isAnalyzingRef = useRef(false);

    // ── stop ─────────────────────────────────────────────────────────────────

    const stop = useCallback(() => {
        isActiveRef.current = false;
        if (intervalRef.current)  { clearInterval(intervalRef.current); intervalRef.current = null; }
        if (processorRef.current) { processorRef.current.disconnect();  processorRef.current = null; }
        streamRef.current?.getTracks().forEach(t => t.stop());
        audioCtxRef.current?.close();
        streamRef.current   = null;
        audioCtxRef.current = null;
        samplesRef.current  = [];
        setPressedNotes(new Set());
        setStatus('idle');
    }, []);

    // ── start ─────────────────────────────────────────────────────────────────

    const start = useCallback(async (_a4Hz: number = 440) => {
        if (isActiveRef.current) return;
        isActiveRef.current = true;

        setStatus('requesting');
        setErrorMessage(null);
        setPressedNotes(new Set());

        try {
            // 1. Request microphone access (no DSP processing — raw piano signal).
            const stream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: false,
                    noiseSuppression: false,
                    autoGainControl:  false,
                },
                video: false,
            });
            streamRef.current = stream;

            // 2. Web Audio context.
            const AudioCtor =
                window.AudioContext ??
                (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
            const ctx = new AudioCtor();
            await ctx.resume();
            audioCtxRef.current = ctx;

            // 3. Load the BasicPitch TF.js model (only on first call; cached in ref).
            setStatus('loading');
            if (!basicPitchRef.current) {
                basicPitchRef.current = new BasicPitch(MODEL_URL);
                // Warm-up inference: triggers TF.js graph compilation so the first
                // real tick does not spike latency.
                const warmup = new Float32Array(BP_SAMPLE_RATE); // 1 s of silence
                await basicPitchRef.current.evaluateModel(warmup, () => {}, () => {});
            }

            // 4. Capture audio samples into a ring buffer via ScriptProcessorNode.
            //    Note: ScriptProcessorNode is deprecated but has universal browser support.
            //    Migration to AudioWorkletNode can be done without changing the rest of
            //    this hook (only the capture section needs to change).
            const CHUNK_SIZE = 2048; // samples per callback at browser SR
            const maxChunks  = Math.ceil((BUFFER_SEC * ctx.sampleRate) / CHUNK_SIZE);

            const processor = ctx.createScriptProcessor(CHUNK_SIZE, 1, 1);
            processorRef.current = processor;

            const source  = ctx.createMediaStreamSource(stream);
            const silence = ctx.createGain();
            silence.gain.value = 0; // prevent microphone feedback through speakers

            source.connect(processor);
            processor.connect(silence);
            silence.connect(ctx.destination); // ScriptProcessorNode requires a destination path

            processor.onaudioprocess = (e: AudioProcessingEvent) => {
                if (!isActiveRef.current) return;
                // Copy the input buffer (it is reused by the browser after the callback).
                samplesRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
                // Evict the oldest chunk to keep the ring buffer at BUFFER_SEC.
                if (samplesRef.current.length > maxChunks) {
                    samplesRef.current.splice(0, samplesRef.current.length - maxChunks);
                }
            };

            setStatus('active');

            // 5. Periodic analysis loop.
            intervalRef.current = setInterval(async () => {
                if (!isActiveRef.current || isAnalyzingRef.current) return;
                const chunks = samplesRef.current.slice(); // snapshot

                isAnalyzingRef.current = true;
                try {
                    const ctx2 = audioCtxRef.current;
                    const bp   = basicPitchRef.current;
                    if (!ctx2 || !bp) return;

                    // Concatenate ring-buffer chunks into a single AudioBuffer at browser SR.
                    const totalLen  = chunks.reduce((s, c) => s + c.length, 0);
                    if (totalLen < Math.ceil(MIN_ANALYSIS_SEC * ctx2.sampleRate)) return;
                    const nativeBuf = ctx2.createBuffer(1, totalLen, ctx2.sampleRate);
                    const nativeData = nativeBuf.getChannelData(0);
                    let offset = 0;
                    for (const chunk of chunks) { nativeData.set(chunk, offset); offset += chunk.length; }

                    // Resample from browser SR to 22 050 Hz using the OfflineAudioContext
                    // resampler — accurate and fast (< 50 ms for a 2-second buffer).
                    const resampledLen = Math.ceil(totalLen * BP_SAMPLE_RATE / ctx2.sampleRate);
                    const offline      = new OfflineAudioContext(1, resampledLen, BP_SAMPLE_RATE);
                    const offSrc       = offline.createBufferSource();
                    offSrc.buffer      = nativeBuf;
                    offSrc.connect(offline.destination);
                    offSrc.start(0);
                    const resampledBuf  = await offline.startRendering();
                    const resampledData = resampledBuf.getChannelData(0);

                    // Run the BasicPitch neural network.
                    const frames:   number[][] = [];
                    const onsets:   number[][] = [];
                    const contours: number[][] = [];
                    await bp.evaluateModel(
                        resampledData,
                        (f, o, c) => { frames.push(...f); onsets.push(...o); contours.push(...c); },
                        () => {},
                    );

                    // Convert frame-level predictions to time-stamped note events.
                    const rawNotes = outputToNotesPoly(
                        frames, onsets,
                        ONSET_THR, FRAME_THR, MIN_NOTE_FRAMES,
                        /* inferOnsets */ false,
                    );
                    const notes = noteFramesToTime(addPitchBendsToNoteEvents(contours, rawNotes));

                    // Determine which notes are still sounding at the "current" moment
                    // (= the end of the analysed buffer).
                    const totalDurSec  = resampledData.length / BP_SAMPLE_RATE;
                    const activeCutoff = totalDurSec - NOTE_ACTIVE_WINDOW_S;
                    const active       = new Set<number>();
                    for (const note of notes) {
                        const endSec = note.startTimeSeconds + note.durationSeconds;
                        if (endSec >= activeCutoff) {
                            active.add(note.pitchMidi);
                        }
                    }
                    setPressedNotes(active);
                } finally {
                    isAnalyzingRef.current = false;
                }
            }, STEP_MS);

        } catch (err: unknown) {
            isActiveRef.current = false;
            let code: string | null = null;
            if (err instanceof Error) {
                if (err.name === 'NotAllowedError'  || err.name === 'PermissionDeniedError') code = 'MICROPHONE_DENIED';
                else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') code = 'MICROPHONE_NOT_FOUND';
                else if (err.name === 'NotReadableError' || err.name === 'TrackStartError')   code = 'MICROPHONE_IN_USE';
            }
            setErrorMessage(code ?? (err instanceof Error ? err.message : 'Unknown error'));
            setStatus('error');
        }
    }, []);

    return { status, errorMessage, pressedNotes, start, stop };
}
