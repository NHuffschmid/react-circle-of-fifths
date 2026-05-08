import React from 'react';
import { CircleOfFifths } from '../../src';

// C major is index 0 in the Circle of Fifths (0 = C, 1 = G, 2 = D, …)
const C_MAJOR_INDEX = 0;

function App() {
    return (
        <div style={{
            width: '100vw',
            height: '100vh',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: '#000',
        }}>
            <div style={{
                width: 'min(90vw, 90vh)',
                height: 'min(90vw, 90vh)',
                position: 'relative',
            }}>
                <CircleOfFifths selectedMajorKeys={[C_MAJOR_INDEX]} />
            </div>
        </div>
    );
}

export default App;
