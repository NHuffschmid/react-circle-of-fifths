/**
 * Ambient type declarations for the react-piano-keyboard peer dependency.
 *
 * react-piano-keyboard is source-distributed and not published to npm.
 * The consuming application must provide a module alias (e.g. via Vite's
 * `resolve.alias`) pointing `react-piano-keyboard` to the actual source.
 *
 * These declarations are used only during typecheck in this standalone repo.
 * In the consuming app, the actual types from react-piano-keyboard are used.
 */
declare module 'react-piano-keyboard' {
    export type SupportedLanguage = 'de' | 'en' | 'fr' | 'it' | 'es' | 'pt';

    export type ChromaticNoteName = {
        /** Primary note name for this pitch class in the given language. */
        primary: string;
        /** Secondary (enharmonic) note name, e.g. for sharps/flats. */
        secondary?: string;
    };

    /** Skrjabin color mapping: 12 hex color strings indexed by chromatic pitch class (0=C). */
    export const skrjabinColors: string[];

    /** Note name lookup table: language → 12 ChromaticNoteName entries (indexed by pitch class). */
    export const NOTE_NAMES: Record<SupportedLanguage, ChromaticNoteName[]>;

    /** Resolves a raw language string to the nearest supported SupportedLanguage. Defaults to 'en'. */
    export function resolveLanguage(lang: string | undefined): SupportedLanguage;
}
