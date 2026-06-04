# Circle of Fifths – Listener App

A browser-based app that listens to a microphone, detects piano notes in real time using a neural network, and displays the detected key on an interactive Circle of Fifths.

Live demo: <https://nhuffschmid.github.io/react-circle-of-fifths/>

---

## How it works

### 1. Microphone capture

The app requests microphone access via `getUserMedia` with echo cancellation, noise suppression, and auto-gain control all disabled. This gives the cleanest possible signal for musical analysis.

Audio is captured with a `ScriptProcessorNode` in chunks of 2 048 samples at the browser's native sample rate (44 100 or 48 000 Hz). Each chunk is appended to a ring buffer that retains the most recent 0.9 seconds of audio.

### 2. Resampling

Before every inference run the ring-buffer contents are concatenated into a single `AudioBuffer` at the browser's native sample rate and then resampled to **22 050 Hz** using an `OfflineAudioContext`. This is the sample rate at which the BasicPitch model was trained; the conversion step is required regardless of the device's native rate.

### 3. Neural-network inference (BasicPitch)

The resampled `Float32Array` is fed into the **[@spotify/basic-pitch](https://github.com/spotify/basic-pitch-ts)** TF.js model every 120 ms. The model processes audio in overlapping frames (hop size 512 samples ≈ 23 ms) and produces three output arrays per frame:

| Output | Shape per frame | Meaning |
|---|---|---|
| `frames` | 88 values | Frame-level probability that each piano key is active |
| `onsets` | 88 values | Probability that a new note began in this frame |
| `contours` | 264 values | Sub-semitone pitch bend contour |

The 88 outputs cover exactly the full piano range (MIDI 21 – 108, A0 – C8).

### 4. Note decoding

`outputToNotesPoly` converts the per-frame matrices into discrete `NoteEvent` objects using:

- an onset threshold of **0.30** — minimum onset probability to start a new note
- a frame threshold of **0.25** — minimum frame probability to sustain an active note
- a minimum duration of **3 frames** (~70 ms) — short spikes are discarded

`addPitchBendsToNoteEvents` attaches pitch-bend contours from the `contours` matrix, and `noteFramesToTime` converts frame indices to absolute timestamps in seconds.

### 5. Active-note selection

After each inference, notes whose end time (`startTimeSeconds + durationSeconds`) falls within the last **0.25 s** of the analysed buffer are considered "currently pressed" and reported as a `Set<midiNote>`. Notes that ended before that window are ignored; any note sounding right up to the buffer edge remains visible until it drops out of the window on a subsequent tick.

This sliding window approach is immune to room reverb and sustain-pedal resonance — it uses note-level timestamps from the model, not raw signal energy.

### 6. Key display

The `Set<midiNote>` is passed as `pressedNotes` to `useCircleOfFifthsDetection`, the same hook used by the main Depinus app. That hook matches the detected pitch classes against tonic-triad and diatonic scale templates and highlights the resulting key(s) on the `CircleOfFifths` SVG component.

---

## Architecture

```
getUserMedia
    │
    ▼
ScriptProcessorNode (chunk 2048 samples)
    │  ring buffer — last 0.9 s
    ▼
OfflineAudioContext resampler → 22 050 Hz Float32Array
    │
    ▼
useBasicPitchDetection       ← pitchDetection/useBasicPitchDetection.ts
    │  every 120 ms
    │  BasicPitch (TF.js) → frames / onsets / contours
    │  outputToNotesPoly → NoteEventTime[]
    │  active-note window → Set<midiNote>
    ▼
useCircleOfFifthsDetection   ← shared with main Depinus app
    │  selectedMajorKeys / selectedMinorKeys
    ▼
CircleOfFifths (SVG)         ← shared React component
```

The pitch-detection engine is isolated behind a single swap point (`pitchDetection/index.ts`). The previous FFT-chroma engine (`useChromaDetection.ts`) is still available in the same folder as a lightweight offline fallback — switching back requires changing exactly one import line.

---

## Development

```bash
npm install        # also copies the BasicPitch model to public/basic-pitch-model/
npm run dev        # start Vite dev server
npm run build      # production build → dist/
npm run typecheck  # TypeScript type check without emitting
npm run deploy     # build + push to GitHub Pages (gh-pages)
```

The `postinstall` hook (`scripts/copy-basic-pitch-model.cjs`) copies
`node_modules/@spotify/basic-pitch/model/*` into `public/basic-pitch-model/` so
that Vite can serve the TF.js model during development and bundle it into `dist/`
for production. The folder is listed in `.gitignore` because it is fully derived
from the npm package.

### Language support

The UI automatically detects the browser language and pre-selects it if it is one of the six supported languages: **DE, EN, FR, IT, ES, PT**. The user can change the language at any time via the selector in the top-right corner. Note names on the Circle of Fifths update accordingly.

---

## Configuration (useBasicPitchDetection.ts)

| Constant | Value | Description |
|---|---|---|
| `BUFFER_SEC` | 0.9 | Rolling audio buffer length analysed per tick (seconds) |
| `STEP_MS` | 120 | Interval between inference runs (ms); effective latency ≈ `STEP_MS` + inference time |
| `ONSET_THR` | 0.30 | BasicPitch onset detection threshold (0–1); raise to reduce false note onsets |
| `FRAME_THR` | 0.25 | BasicPitch frame activation threshold (0–1); raise to suppress ghost/soft notes |
| `MIN_NOTE_FRAMES` | 3 | Minimum note duration in model frames (~70 ms); shorter events are discarded |
| `MIN_ANALYSIS_SEC` | 0.35 | Minimum buffered audio required before the first inference starts |
| `NOTE_ACTIVE_WINDOW_S` | 0.25 | Notes ending within this many seconds of the buffer edge are shown as active |
| `BP_SAMPLE_RATE` | 22 050 | Model sample rate — fixed; do not change |

### Fallback engine (useChromaDetection.ts)

| Constant | Value | Description |
|---|---|---|
| `FFT_SIZE` | 8192 | FFT window size |
| `CHORD_MIN_SCORE` | 0.55 | Minimum triad template score for activation |
| `CHORD_SWITCH_SCORE` | 0.80 | Score required to switch to a different chord |
| `CANDIDATE_MIN_WINS` | 5 | Consecutive ticks required for activation (~250 ms) |
| `ANALYSIS_INTERVAL_MS` | 50 | Milliseconds between analysis ticks |

To switch back to the FFT-chroma engine, change the re-export in `pitchDetection/index.ts`:

```ts
// fast, triads only, no ML model, works offline
export { useChromaDetection as usePitchDetection } from './useChromaDetection';
```

---

## Licenses

- **React** – MIT
- **qrcode.react** – MIT
- **Vite** – MIT
- **@spotify/basic-pitch** – Apache 2.0
- **@tensorflow/tfjs** – Apache 2.0
- **Web Audio API** – browser built-in, no license required