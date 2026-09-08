/**
 * Emotion taxonomy — a comprehensive palette of human emotions the tagger can
 * assign to a memory, plus the metadata the dashboard uses to tint a "neuron"
 * by how it feels.
 *
 * Memories aren't affect-neutral: a prod outage is remembered with stress, a
 * shipped feature with pride, a kind word with warmth. Tagging that lets recall
 * and consolidation be affect-aware, and lets the visualiser colour the graph
 * by mood. The old tagger only suggested a handful of words to the LLM, so it
 * picked arbitrary, inconsistent labels. This module gives it a real vocabulary
 * grounded in emotion research (Plutchik's wheel + Cowen & Keltner's 27
 * categories + everyday affect terms), grouped into families with a valence and
 * a hue so colouring is consistent.
 *
 * The palette is broad on purpose — the goal is to cover the full range of what
 * a person actually feels, not just six "basic" emotions.
 */
export type Valence = "positive" | "negative" | "neutral" | "ambivalent";
export interface EmotionFamily {
    /** Family label (also a valid emotion in its own right). */
    key: string;
    valence: Valence;
    /** Base hue (0–360); kept for reference, but `color` is what the dashboard uses. */
    hue: number;
    /**
     * Explicit, perceptually-distinct swatch (hex) for dashboard tinting. Chosen
     * by hand so all 21 affect families read apart from each other (hue alone
     * collides — too many greens/purples/blues land on top of one another), and
     * so untagged/neutral memories stay quiet while felt ones pop. Intensity
     * modulates vividness, not the hue.
     */
    color: string;
    /** Emotions belonging to this family, fine- to coarse-grained. */
    members: string[];
}
/**
 * The full taxonomy, by family. Order matters only for display; lookup is by
 * member name. Each family owns one distinct colour so the graph reads as
 * mood-coloured regions and every emotion is legible against the others.
 */
export declare const EMOTION_FAMILIES: EmotionFamily[];
interface EmotionInfo {
    family: string;
    valence: Valence;
    hue: number;
    color: string;
}
/** Every emotion in the palette, flat and de-duplicated (lowercase). */
export declare const EMOTIONS: string[];
/**
 * emotion -> { color, hue, valence, family } so any frontend can colour neurons
 * by feeling. Shared single source of truth for the dashboard server and CLI.
 */
export declare function emotionPalette(): Record<string, {
    color: string;
    hue: number;
    valence: Valence;
    family: string;
}>;
/** One swatch per family, valence-ordered, for an emotion legend (excludes plain "neutral"). */
export declare function emotionFamilyLegend(): Array<{
    key: string;
    color: string;
    valence: Valence;
}>;
/** Look up an emotion's family/valence/hue, or undefined if unknown. */
export declare function emotionInfo(emotion: string | undefined | null): EmotionInfo | undefined;
/** Coarse valence for an emotion (defaults to neutral if unrecognised). */
export declare function emotionValence(emotion: string | undefined | null): Valence;
/** Whether a label is a recognised palette emotion. */
export declare function isKnownEmotion(emotion: string): boolean;
/** A memory's affect, extracted from its stored metadata. */
export interface Affect {
    /** The emotion label, if tagged (lowercase). */
    emotion?: string;
    /** Emotional intensity 0..1 (0 when untagged). The "save this" arousal flag. */
    intensity: number;
    valence: Valence;
}
/**
 * Pull a memory's affect out of its metadata, tolerant of where the tagger put
 * it: emotion/intensity may sit at the top level OR nested under `metadata:`
 * (frontmatter convention), and the intensity key may be `emotionIntensity` or
 * `emotion_intensity`. Intensity is clamped to [0,1] (a 1..10 value is /10'd).
 * Returns a zero-intensity neutral affect when nothing is tagged — so callers
 * can fold it into a score unconditionally without changing untagged memories.
 */
export declare function affectFromMetadata(metadata: Record<string, unknown> | null | undefined): Affect;
/**
 * A compact, grouped rendering of the palette for an LLM prompt — families on
 * one line each so the model sees the full range without a giant flat list.
 */
export declare function emotionPalettePrompt(): string;
export {};
//# sourceMappingURL=emotions.d.ts.map