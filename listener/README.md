# Circle of Fifths – Listener App

A browser-based app that listens to a microphone, detects piano chords in real time, and displays the detected key on an interactive Circle of Fifths.

Live demo: <https://nhuffschmid.github.io/react-circle-of-fifths/>

---

## How it works

### 1. Microphone capture

The app requests microphone access via `getUserMedia` with echo cancellation, noise suppression, and auto-gain control all disabled. This gives the cleanest possible signal for musical analysis.

### 2. FFT analysis (Web Audio API)

An `AnalyserNode` computes a Fast Fourier Transform (FFT) with a window size of 8 192 samples every 50 ms. At the browser's native 48 kHz sample rate this gives a frequency resolution of ~5.9 Hz/bin, which is sufficient to reliably separate adjacent piano keys.

### 3. Chroma vector

Each FFT bin is mapped to one of the 12 chromatic pitch classes (C, C#, D, …, B) by converting the bin's frequency to the nearest MIDI note (`12 × log₂(f / 440) + 69`) and taking `note mod 12`. The average energy per pitch class is computed, normalised by the number of bins it covers, and smoothed over a rolling window of 3 frames (~150 ms) to suppress attack transients.

### 4. Chord template matching

The smoothed chroma vector is compared against all 24 major and minor triad templates (one per key in circle-of-fifths order). For each candidate chord the score is:

```
score = (energy[note1] + energy[note2] + energy[note3]) / (3 × maxEnergy)
```

A score ≥ 0.60 means the three chord notes together average at least 60 % of the strongest pitch class's energy. The highest-scoring template is selected. Harmonic overtone bleed (e.g. G's 3rd harmonic landing on D) cannot push a wrong chord above threshold because all three template notes must score together.

### 5. Stability voting (sliding window)

The last 8 tick results (400 ms) are kept in a rolling window. A chord is activated or switched-to only when it wins at least 5 of those 8 ticks (~250 ms minimum latency). Piano attack transients that dominate for only 1–3 ticks therefore never trigger a key change, eliminating the momentary flicker that occurs when a chord is struck. Once active, the chord is cleared only when its own vote count in the window drops below 3 (~300–350 ms of silence).

### 6. Key display

The detected chord's three MIDI notes are passed as `pressedNotes` to `useCircleOfFifthsDetection`, the same hook used by the Depinus app. That hook matches the pitch classes against tonic-triad and diatonic scale templates and highlights the resulting key(s) on the `CircleOfFifths` SVG component.

---

## Architecture

```
getUserMedia
    │
    ▼
AnalyserNode (FFT 8192)
    │  every 50 ms
    ▼
useChromaDetection          ← pitchDetection/useChromaDetection.ts
    │  Set<midiNote>
    ▼
useCircleOfFifthsDetection  ← shared with main Depinus app
    │  selectedMajorKeys / selectedMinorKeys
    ▼
CircleOfFifths (SVG)        ← shared React component
```

The pitch-detection engine is isolated behind a single swap point (`pitchDetection/index.ts`). Switching to a different engine (e.g. a machine-learning based approach) requires changing exactly one import line.

---

## Development

```bash
npm install
npm run dev        # start Vite dev server
npm run build      # production build → dist/
npm run typecheck  # TypeScript type check without emitting
npm run deploy     # build + push to GitHub Pages (gh-pages)
```

### Language support

The UI automatically detects the browser language and pre-selects it if it is one of the six supported languages: **DE, EN, FR, IT, ES, PT**. The user can change the language at any time via the selector in the top-right corner. Note names on the Circle of Fifths update accordingly.

---

## Configuration (useChromaDetection.ts)

| Constant | Default | Description |
|---|---|---|
| `FFT_SIZE` | 8192 | FFT window size; higher = better frequency resolution |
| `SMOOTHING_FRAMES` | 3 | Rolling average over this many 50 ms frames |
| `MIN_PEAK_ENERGY` | 10 | Minimum peak energy before chord detection runs |
| `CHORD_MIN_SCORE` | 0.60 | Minimum template match score (0–1) |
| `CANDIDATE_WINDOW_SIZE` | 8 | Number of recent ticks kept for stability voting (~400 ms) |
| `CANDIDATE_MIN_WINS` | 5 | Votes required in the window to activate a chord (~250 ms) |
| `CANDIDATE_DEACTIVATE_MIN` | 3 | Vote count below which the active chord is cleared |
| `ANALYSIS_INTERVAL_MS` | 50 | Milliseconds between analysis ticks |

---

## Licenses

- **React** – MIT
- **qrcode.react** – MIT
- **Vite** – MIT
- **Web Audio API** – browser built-in, no license required
