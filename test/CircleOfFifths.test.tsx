import React from 'react';
import { render, screen } from '@testing-library/react';
import CircleOfFifths from '../src/CircleOfFifths';

// Mock react-piano-keyboard peer dependency
vi.mock('react-piano-keyboard', () => ({
    skrjabinColors: Array.from({ length: 12 }, (_, i) => `#${i.toString().padStart(6, '0')}`),
    NOTE_NAMES: {
        en: Array.from({ length: 12 }, (_, i) => ({ primary: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'][i], secondary: undefined })),
    },
    resolveLanguage: (lang: string) => (lang === 'en' ? 'en' : 'en'),
}));

describe('CircleOfFifths', () => {
    it('renders without crashing', () => {
        const { container } = render(<CircleOfFifths />);
        expect(container.querySelector('svg')).toBeTruthy();
    });

    it('renders 12 major segments', () => {
        const { container } = render(<CircleOfFifths />);
        const paths = container.querySelectorAll('path');
        // Each segment has 3 rings (major, minor, optional accidentals) = at least 2 paths each
        expect(paths.length).toBeGreaterThanOrEqual(12);
    });

    it('applies low opacity when nothing is selected', () => {
        const { container } = render(<CircleOfFifths />);
        // Opacity is applied per segment <g> element, not on the <svg> root.
        const firstSegmentGroup = container.querySelector('svg > g > g') as SVGGElement;
        expect(firstSegmentGroup.getAttribute('opacity')).toBe('0.2');
    });

    it('applies full opacity when a major key is selected', () => {
        const { container } = render(<CircleOfFifths selectedMajorKeys={[0]} />);
        // Segment 0 (C major) should have full opacity when selected.
        const firstSegmentGroup = container.querySelector('svg > g > g') as SVGGElement;
        expect(firstSegmentGroup.getAttribute('opacity')).toBe('0.9');
    });
});
