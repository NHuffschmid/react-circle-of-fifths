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

Each FFT bin is mapped to one of the 12 chromatic pitch classes (C, C#, D, …, B) by converting the bin's frequency to the nearest MIDI note (`12 × log₂(f / 440) + 69`) and taking `note mod 12`. The average energy per pitch class is computed and normalised by the number of bins it covers. No rolling average is applied — each tick uses the raw per-class energy from the current AnalyserNode frame. The `AnalyserNode.smoothingTimeConstant = 0.2` provides sufficient inter-frame noise suppression and allows energy to drop within ~150 ms after key release.

### 4. Bass fundamental reconstruction (harmonic series analysis)

Standard microphones barely capture audio at fundamental frequencies below ~100 Hz. Bass piano notes (A0–C3, ≈ 27–130 Hz) therefore produce almost no energy at their fundamental in the FFT, even though their harmonics (2f, 3f, 4f, …) are clearly present. The consequence is that a bass chord such as C2–E2–G2 is systematically misidentified as G major: the 3rd-harmonic series of C2, E2, and G2 lands on G3, B3, and D4, making G major appear to dominate the chroma vector.

`detectMissingFundamentals` corrects this by mimicking the psychoacoustic *missing fundamental* effect — the brain's ability to recognise a pitch from its overtone pattern even when the fundamental is inaudible:

1. For each bass MIDI note 21–48 (A0–C3), compute the expected frequencies of harmonics 2f through 8f.
2. For each harmonic that falls within the piano range (below 4 200 Hz), read the FFT bin energy.
3. If the bin energy exceeds the noise floor (15/255), add a weighted contribution `energy / harmonic` to a running score (higher harmonics are naturally weaker and are down-weighted accordingly).
4. If at least **3 harmonics** are found and the weighted average score exceeds **25**, the fundamental is declared reconstructed. Its energy is capped at 200 to avoid overshadowing directly captured treble fundamentals.

The reconstructed energies are merged into the chroma vector via `Math.max`, preventing double-counting in the rare cases where the fundamental was actually captured by the microphone.

### 5. Chord template matching

The chroma vector is compared against all 24 major and minor triad templates (one per key in circle-of-fifths order). For each candidate chord the score is:

```
score = (energy[note1] + energy[note2] + energy[note3]) / (3 × maxEnergy)
```

A score ≥ 0.55 means the three chord notes together average at least 55 % of the strongest pitch class's energy. The highest-scoring template is selected. Harmonic overtone bleed (e.g. G's 3rd harmonic landing on D) cannot push a wrong chord above threshold because all three template notes must score together.

### 6. Stability voting, onset detection, and display timing

The last 15 tick results (~750 ms) are kept in a rolling window. Three distinct gating rules control when the display changes:

**A — Confirmation** (same chord as currently displayed): a single tick with score ≥ `CHORD_MIN_SCORE` (0.55) resets the inactivity timer and keeps the chord visible. No window run required. This prevents a momentary score dip from causing a premature clear while the chord is still audible.

**B — Fresh activation** (nothing displayed): the chord must win `CANDIDATE_MIN_WINS` = 5 *consecutive* ticks at the tail of the window (~250 ms). Consecutive voting is stricter than a majority count: piano attack transients affect only the first 1–3 ticks and are immediately followed by the correct chord's ticks, so a wrong transient chord can never build a sufficient run.

**C — Chord switch** (different chord while one is displayed): same 5-consecutive-win requirement, but the score must additionally reach `CHORD_SWITCH_SCORE` (0.80). During a piano attack the mixed signal (decaying old chord + noisy new onset) typically scores 0.62–0.72; a cleanly sustained chord reliably scores ≥ 0.82. The displayed chord therefore never switches through a transition artefact.

**Onset detection**: if the raw (single-tick) chroma max energy rises by more than `ONSET_RATIO` (1.5×) in one tick, a new chord onset is detected. The candidate vote window is immediately flushed. This eliminates the “C# minor artefact” that occurs when the decaying tail of chord A overlaps with the attack of chord B and a wrong intermediate chord genuinely scores above the switch threshold.

**Minimum hold time**: a newly confirmed chord cannot replace the displayed chord until the current chord has been visible for at least `MIN_HOLD_MS` (750 ms). This bounds the display update rate to the musician's actual playing tempo and suppresses flutter on fast repeated detection events. First activation from silence is not gated.

**Inactivity deactivation**: when no tick confirms the active chord for `DEACTIVATE_INACTIVITY_MS` (300 ms), the display clears. This is immune to room reverb and piano string resonance — the timer measures wall-clock time since the last confirmation, not signal energy levels.

### 7. Key display

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
    │  Phase 1: standard chroma from FFT bins
    │  Phase 2: bass fundamental reconstruction (detectMissingFundamentals)
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

| Constant | Value | Description |
|---|---|---|
| `FFT_SIZE` | 8192 | FFT window size; higher = better frequency resolution |
| `MIN_PEAK_ENERGY` | 10 | Minimum peak chroma energy before chord detection runs |
| `CHORD_MIN_SCORE` | 0.55 | Minimum template score to confirm or freshly activate a chord |
| `CHORD_SWITCH_SCORE` | 0.80 | Minimum score required to *switch* to a different chord (blocks attack-noise artefacts) |
| `CANDIDATE_WINDOW_SIZE` | 15 | Sliding window size in ticks (~750 ms of history) |
| `CANDIDATE_MIN_WINS` | 5 | Consecutive tail wins required for fresh activation or chord switch (~250 ms) |
| `ONSET_RATIO` | 1.5 | Chroma energy rise factor that triggers onset detection (flushes the vote window) |
| `MIN_HOLD_MS` | 750 | Minimum display time in ms before a chord switch is allowed |
| `DEACTIVATE_INACTIVITY_MS` | 300 | Ms without a chord confirmation before the display clears |
| `ANALYSIS_INTERVAL_MS` | 50 | Milliseconds between analysis ticks |

---

## Licenses

- **React** – MIT
- **qrcode.react** – MIT
- **Vite** – MIT
- **Web Audio API** – browser built-in, no license required
