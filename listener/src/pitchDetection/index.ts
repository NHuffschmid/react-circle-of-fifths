// ── Pitch-detection adapter – single swap point ───────────────────────────────
//
// To replace the detection engine:
//   1. Create a new hook in this folder that returns PitchDetectionResult.
//   2. Change the import alias below (only this line needs to change).
//
// Available engines:
//   useChromaDetection   – Web Audio FFT chroma (~50 ms latency, no model)
//   useBasicPitchDetection – @spotify/basic-pitch TF.js (~1.3 s latency, ML)

export { useChromaDetection as usePitchDetection } from './useChromaDetection';
export type { PitchDetectionResult, PitchDetectionStatus } from './PitchDetectionTypes';
