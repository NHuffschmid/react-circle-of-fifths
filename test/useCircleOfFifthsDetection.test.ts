import { renderHook, act } from '@testing-library/react';
import { vi } from 'vitest';
import { useCircleOfFifthsDetection } from '../src/useCircleOfFifthsDetection';

describe('useCircleOfFifthsDetection – key detection', () => {
    it('returns empty arrays when no notes are pressed', () => {
        const { result } = renderHook(() => useCircleOfFifthsDetection(new Set()));
        expect(result.current.selectedMajorKeys).toEqual([]);
        expect(result.current.selectedMinorKeys).toEqual([]);
        expect(result.current.dominantSeventhMajorKeys).toEqual([]);
    });

    it('detects C major triad (C-E-G = MIDI 60-64-67)', () => {
        const { result } = renderHook(() => useCircleOfFifthsDetection(new Set([60, 64, 67])));
        expect(result.current.selectedMajorKeys).toContain(0);
    });

    it('detects G major triad (G-B-D = MIDI 67-71-74)', () => {
        const { result } = renderHook(() => useCircleOfFifthsDetection(new Set([67, 71, 74])));
        expect(result.current.selectedMajorKeys).toContain(1);
    });

    it('detects A minor triad (A-C-E = MIDI 69-60-64)', () => {
        const { result } = renderHook(() => useCircleOfFifthsDetection(new Set([69, 60, 64])));
        expect(result.current.selectedMinorKeys).toContain(0);
    });

    it('detects G7 dominant seventh chord (G-B-D-F = MIDI 67-71-74-65)', () => {
        const { result } = renderHook(() => useCircleOfFifthsDetection(new Set([67, 71, 74, 65])));
        expect(result.current.dominantSeventhMajorKeys).toContain(1);
    });

    it('does not report dominant seventh when a tonic triad also matches', () => {
        const { result } = renderHook(() => useCircleOfFifthsDetection(new Set([60, 64, 67])));
        expect(result.current.dominantSeventhMajorKeys).toEqual([]);
    });

    it('returns empty when only 2 notes are pressed (below chord threshold)', () => {
        const { result } = renderHook(() => useCircleOfFifthsDetection(new Set([60, 64])));
        expect(result.current.selectedMajorKeys).toEqual([]);
        expect(result.current.selectedMinorKeys).toEqual([]);
        expect(result.current.dominantSeventhMajorKeys).toEqual([]);
    });

    it('passes empty set to pause detection without unmounting', () => {
        const { result, rerender } = renderHook(
            ({ notes }: { notes: Set<number> }) => useCircleOfFifthsDetection(notes),
            { initialProps: { notes: new Set([60, 64, 67]) } },
        );
        expect(result.current.selectedMajorKeys).toContain(0);

        rerender({ notes: new Set() });
        // After clearing, window expires — keys remain until timeout, but no new detection.
        // Just check it doesn't throw.
        expect(result.current).toBeDefined();
    });

    it('clears all detected keys immediately when pressedNotes becomes empty (immediate-release regression)', () => {
        // Regression: both sliding windows and pending timers must be cleared
        // synchronously inside the useEffect when pressedNotes transitions from
        // non-empty to empty — the result must be empty on the very next render,
        // not after WINDOW_MS (2 s) timer expiry.
        const { result, rerender } = renderHook(
            ({ notes }: { notes: Set<number> }) => useCircleOfFifthsDetection(notes),
            { initialProps: { notes: new Set([60, 64, 67]) } }, // C major triad → index 0
        );
        expect(result.current.selectedMajorKeys).toContain(0);

        act(() => {
            rerender({ notes: new Set() });
        });

        expect(result.current.selectedMajorKeys).toEqual([]);
        expect(result.current.selectedMinorKeys).toEqual([]);
        expect(result.current.dominantSeventhMajorKeys).toEqual([]);
    });
});

describe('useCircleOfFifthsDetection – timer cleanup', () => {
    it('unmounts without errors', () => {
        const { unmount } = renderHook(() => useCircleOfFifthsDetection(new Set([60, 64, 67])));
        expect(() => unmount()).not.toThrow();
    });
});
