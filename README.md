# react-circle-of-fifths

![CI](https://github.com/NHuffschmid/react-circle-of-fifths/actions/workflows/ci.yml/badge.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)

A React component that renders an interactive Circle of Fifths with real-time key detection from MIDI input.

## Features

- SVG-based Circle of Fifths with Skrjabin color scheme
- Configurable language for note name labels (de, en, fr, it, es, pt)
- Real-time key detection from pressed MIDI notes (chord and passage mode)
- Major, minor, and dominant seventh chord recognition
- Major/minor discrimination via frequency analysis over a 6-second window
- Accent color for the key signature ring
- Zero runtime dependencies beyond React and `react-piano-keyboard`

## Installation

This package is not published on npm. It is designed to be used as a **git submodule**:

```sh
git submodule add https://github.com/NHuffschmid/react-circle-of-fifths.git path/to/react-circle-of-fifths
```

The package has two peer dependencies that must be provided by the consumer:

- `react >= 18`
- [`react-piano-keyboard`](https://github.com/NHuffschmid/react-piano-keyboard) (also source-distributed)

Since `react-piano-keyboard` is not on npm, the consuming app must configure a module alias
(e.g. via Vite's `resolve.alias`) pointing `react-piano-keyboard` to the
`react-piano-keyboard/src/index.ts` path of its own submodule checkout.

## Usage

### Rendering the Component

```tsx
import { CircleOfFifths } from './react-circle-of-fifths/src';

<CircleOfFifths
    selectedMajorKeys={[0]}        // C major highlighted
    selectedMinorKeys={[]}
    dominantSeventhMajorKeys={[]}
    language="de"
    accentColor="#DC143C"
/>
```

### Key Detection Hook

```tsx
import { useCircleOfFifthsDetection } from './react-circle-of-fifths/src';

const { selectedMajorKeys, selectedMinorKeys, dominantSeventhMajorKeys } =
    useCircleOfFifthsDetection(pressedNotes);
```

`pressedNotes` is a `Set<number>` of currently pressed MIDI note numbers.
Pass an empty set to pause detection without unmounting.

## API

### `<CircleOfFifths />` Props

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `selectedMajorKeys` | `number[]` | `[]` | Circle-of-fifths indices (0=C, clockwise) for highlighted major keys |
| `selectedMinorKeys` | `number[]` | `[]` | Circle-of-fifths indices for highlighted minor keys |
| `dominantSeventhMajorKeys` | `number[]` | `[]` | Indices shown with superscript "7" |
| `language` | `string` | `'en'` | BCP-47 language tag for note name labels |
| `accentColor` | `string` | `'#DC143C'` | CSS color for the accidentals ring |

### `useCircleOfFifthsDetection(pressedNotes)`

| Parameter | Type | Description |
|-----------|------|-------------|
| `pressedNotes` | `Set<number>` | Currently pressed MIDI note numbers |

Returns `CircleOfFifthsDetectionResult`:

| Property | Type | Description |
|----------|------|-------------|
| `selectedMajorKeys` | `number[]` | Detected major key indices |
| `selectedMinorKeys` | `number[]` | Detected minor key indices |
| `dominantSeventhMajorKeys` | `number[]` | Detected dominant seventh chord indices |

## Key Detection Algorithm

Uses a two-window sliding accumulation strategy:

- **Chord mode** (3–4 unique pitch classes in a 2-second window): tonic-triad and dominant-seventh matching.
- **Passage mode** (5+ unique pitch classes): diatonic scale overlap scoring.
- **Discrimination**: when both a major key and its relative/parallel minor are detected, the one whose root appears less frequently in a 6-second window is removed.

## Example

See the [`example/`](example/) directory for a runnable Vite + React demo app.

```sh
cd example
npm install
npm run dev
```

> **Note**: the example requires `react-piano-keyboard` to be checked out as a sibling directory.
> Adjust the alias in `example/vite.config.ts` to match your local path.

## Known Bugs / Limitations

- This project is part of the DEPINUS project: https://github.com/NHuffschmid/depinus
- Other usage scenarios may work but are not tested

## License

MIT

## Author

Norbert Huffschmid <depinus@gmx.de>
