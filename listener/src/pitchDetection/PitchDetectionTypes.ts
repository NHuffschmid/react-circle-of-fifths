/**
 * Status of the pitch-detection pipeline.
 *
 * - idle:       Not started.
 * - requesting: Waiting for the user to grant microphone access.
 * - loading:    Microphone granted; loading / initialising the detection model.
 * - active:     Microphone live, detection running.
 * - error:      Unrecoverable error – see errorMessage.
 */
export type PitchDetectionStatus = 'idle' | 'requesting' | 'loading' | 'active' | 'error';

/**
 * Uniform return type of every pitch-detection hook.
 *
 * App code only depends on this interface.  To swap the underlying engine
 * (Basic Pitch, Meyda, CREPE, …) change the re-export in pitchDetection/index.ts.
 */
export interface PitchDetectionResult {
    /** Current pipeline status. */
    status: PitchDetectionStatus;
    /** Human-readable error description when status === 'error', otherwise null. */
    errorMessage: string | null;
    /** Currently active MIDI note numbers (0–127) derived from the microphone input. */
    pressedNotes: Set<number>;
    /** Start the microphone and the detection pipeline. No-op if already active. */
    start: () => Promise<void>;
    /** Stop the pipeline and release the microphone. */
    stop: () => void;
}
