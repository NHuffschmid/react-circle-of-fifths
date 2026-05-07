import React, { useState, useCallback } from 'react';
import { CircleOfFifths, useCircleOfFifthsDetection } from '../../src';

/**
 * Demo App for react-circle-of-fifths.
 *
 * Click the buttons to simulate pressing MIDI notes.
 * The Circle of Fifths will highlight the detected key in real time.
 */
function App() {
    const [pressedNotes, setPressedNotes] = useState<Set<number>>(new Set());
    const detection = useCircleOfFifthsDetection(pressedNotes);

    const toggleNote = useCallback((note: number) => {
        setPressedNotes(prev => {
            const next = new Set(prev);
            if (next.has(note)) {
                next.delete(note);
            } else {
                next.add(note);
            }
            return next;
        });
    }, []);

    const clear = useCallback(() => setPressedNotes(new Set()), []);

    // C major triad: C-E-G
    const cMajor = [60, 64, 67];
    // G major triad: G-B-D
    const gMajor = [67, 71, 74];
    // A minor triad: A-C-E
    const aMinor = [69, 72, 76];
    // G7: G-B-D-F
    const g7 = [67, 71, 74, 65];

    return (
        <div style={{ fontFamily: 'sans-serif', padding: 32, maxWidth: 600, margin: '0 auto' }}>
            <h1>react-circle-of-fifths Demo</h1>
            <p>Click chord buttons to simulate MIDI input. The circle highlights the detected key.</p>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
                <button onClick={() => { clear(); cMajor.forEach(toggleNote); }}>C major</button>
                <button onClick={() => { clear(); gMajor.forEach(toggleNote); }}>G major</button>
                <button onClick={() => { clear(); aMinor.forEach(toggleNote); }}>a minor</button>
                <button onClick={() => { clear(); g7.forEach(toggleNote); }}>G7</button>
                <button onClick={clear}>Clear</button>
            </div>

            <p style={{ fontSize: 14, color: '#666' }}>
                Pressed notes: {[...pressedNotes].sort((a, b) => a - b).join(', ') || '—'}
            </p>

            <p style={{ fontSize: 14, color: '#666' }}>
                Detected: major={JSON.stringify(detection.selectedMajorKeys)}{' '}
                minor={JSON.stringify(detection.selectedMinorKeys)}{' '}
                dom7={JSON.stringify(detection.dominantSeventhMajorKeys)}
            </p>

            <div style={{ position: 'relative', width: 400, height: 400, margin: '0 auto' }}>
                <CircleOfFifths
                    selectedMajorKeys={detection.selectedMajorKeys}
                    selectedMinorKeys={detection.selectedMinorKeys}
                    dominantSeventhMajorKeys={detection.dominantSeventhMajorKeys}
                    language="en"
                    accentColor="#DC143C"
                />
            </div>
        </div>
    );
}

export default App;
