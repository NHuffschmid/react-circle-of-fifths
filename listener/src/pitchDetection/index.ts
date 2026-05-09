// ── Pitch-detection adapter – single swap point ───────────────────────────────
//
// To replace the detection engine:
//   1. Create a new hook in this folder that returns PitchDetectionResult.
//   2. Change the import alias below (only this line needs to change).
//
// Example swap:
//   export { useMeydaDetection as usePitchDetection } from './useMeydaDetection';

export { useBasicPitchDetection as usePitchDetection } from './useBasicPitchDetection';
export type { PitchDetectionResult, PitchDetectionStatus } from './PitchDetectionTypes';
