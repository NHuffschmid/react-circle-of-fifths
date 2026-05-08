// Stub for react-piano-keyboard peer dependency — used in vitest via alias.
// Tests that need specific values should override with vi.mock().

export const skrjabinColors: string[] = Array.from({ length: 12 }, () => '#000000');

export const NOTE_NAMES: Record<string, { primary: string; secondary?: string }[]> = {
    en: ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].map(n => ({ primary: n })),
};

export function resolveLanguage(lang: string): string {
    return lang in NOTE_NAMES ? lang : 'en';
}
