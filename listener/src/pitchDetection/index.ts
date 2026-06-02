// ── Pitch-detection adapter – single swap point ───────────────────────────────
//
// To replace the detection engine:
//   1. Create a new hook in this folder that returns PitchDetectionResult.
//   2. Change the import alias below (only this line needs to change).
//
// Available engines:
//   useBasicPitchDetection – @spotify/basic-pitch neural net (~400–600 ms latency,
//                            polyphonic, full 88-key range, loads TF.js model)
//   useChromaDetection     – Web Audio FFT chroma (~250 ms latency, triads only,
//                            no model — fallback / offline use)

export { useBasicPitchDetection as usePitchDetection } from './useBasicPitchDetection';
export type { PitchDetectionResult, PitchDetectionStatus } from './PitchDetectionTypes';
