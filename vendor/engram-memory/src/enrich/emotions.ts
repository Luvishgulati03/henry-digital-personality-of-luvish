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
export const EMOTION_FAMILIES: EmotionFamily[] = [
  { key: "joy", valence: "positive", hue: 45, color: "#FFCE3B", members: [
    "joy", "happiness", "delight", "glee", "cheerfulness", "elation",
    "euphoria", "ecstasy", "bliss", "jubilation", "pleasure", "enjoyment" ] },
  { key: "amusement", valence: "positive", hue: 33, color: "#FF9E2C", members: [
    "amusement", "playfulness", "mirth", "silliness", "lightheartedness" ] },
  { key: "love", valence: "positive", hue: 330, color: "#FF5DA2", members: [
    "love", "affection", "tenderness", "warmth", "fondness", "adoration",
    "compassion", "empathy", "caring", "intimacy", "attraction", "desire",
    "infatuation", "romance" ] },
  { key: "gratitude", valence: "positive", hue: 145, color: "#58D68D", members: [
    "gratitude", "thankfulness", "appreciation", "indebtedness" ] },
  { key: "pride", valence: "positive", hue: 262, color: "#B07CFF", members: [
    "pride", "triumph", "accomplishment", "confidence", "self-assurance",
    "satisfaction", "vindication" ] },
  { key: "admiration", valence: "positive", hue: 252, color: "#7B5CFF", members: [
    "admiration", "respect", "reverence", "esteem" ] },
  { key: "awe", valence: "ambivalent", hue: 222, color: "#5C8BFF", members: [
    "awe", "wonder", "amazement", "fascination" ] },
  { key: "hope", valence: "positive", hue: 174, color: "#19C3B2", members: [
    "hope", "optimism", "anticipation", "eagerness", "enthusiasm", "excitement",
    "exhilaration", "inspiration", "motivation", "determination", "zeal" ] },
  { key: "interest", valence: "neutral", hue: 192, color: "#3FC1E0", members: [
    "interest", "curiosity", "intrigue", "engagement", "focus", "alertness",
    "contemplation", "concentration" ] },
  { key: "serenity", valence: "positive", hue: 184, color: "#74E0E8", members: [
    "serenity", "calmness", "contentment", "peace", "tranquility", "relaxation",
    "relief", "ease", "comfort", "reassurance" ] },
  { key: "surprise", valence: "ambivalent", hue: 52, color: "#FFE45E", members: [
    "surprise", "astonishment", "shock", "startle", "disbelief", "realization" ] },
  { key: "nostalgia", valence: "ambivalent", hue: 32, color: "#D9A066", members: [
    "nostalgia", "sentimentality", "wistfulness", "longing", "yearning",
    "homesickness" ] },
  { key: "sadness", valence: "negative", hue: 214, color: "#3E6DB5", members: [
    "sadness", "sorrow", "grief", "despair", "hopelessness", "disappointment",
    "melancholy", "loneliness", "heartbreak", "gloom", "dejection", "misery",
    "anguish", "mourning", "regret" ] },
  { key: "fear", valence: "negative", hue: 282, color: "#9B30D9", members: [
    "fear", "anxiety", "nervousness", "worry", "dread", "apprehension",
    "panic", "terror", "horror", "unease", "insecurity", "vulnerability",
    "trepidation" ] },
  { key: "stress", valence: "negative", hue: 17, color: "#FF6A2B", members: [
    "stress", "overwhelm", "pressure", "tension", "distress", "helplessness",
    "burnout", "exhaustion", "frazzled" ] },
  { key: "anger", valence: "negative", hue: 0, color: "#E63A3A", members: [
    "anger", "frustration", "irritation", "annoyance", "rage", "fury",
    "resentment", "indignation", "hostility", "bitterness", "exasperation",
    "outrage", "agitation" ] },
  { key: "disgust", valence: "negative", hue: 66, color: "#A6B838", members: [
    "disgust", "revulsion", "distaste", "aversion", "loathing", "contempt",
    "disdain", "scorn" ] },
  { key: "shame", valence: "negative", hue: 30, color: "#C0701F", members: [
    "shame", "guilt", "embarrassment", "humiliation", "remorse",
    "self-consciousness", "mortification", "sheepishness" ] },
  { key: "envy", valence: "negative", hue: 146, color: "#2F8F5B", members: [
    "envy", "jealousy", "covetousness" ] },
  { key: "confusion", valence: "neutral", hue: 225, color: "#9AA7C7", members: [
    "confusion", "doubt", "uncertainty", "ambivalence", "conflicted",
    "skepticism", "suspicion", "distrust", "hesitation", "bewilderment" ] },
  { key: "boredom", valence: "negative", hue: 220, color: "#6B7486", members: [
    "boredom", "apathy", "indifference", "disinterest", "weariness", "fatigue",
    "numbness", "listlessness", "restlessness" ] },
  { key: "neutral", valence: "neutral", hue: 222, color: "#5B6577", members: [ "neutral" ] },
];

interface EmotionInfo {
  family: string;
  valence: Valence;
  hue: number;
  color: string;
}

const META = new Map<string, EmotionInfo>();
for (const fam of EMOTION_FAMILIES) {
  for (const m of fam.members) {
    if (!META.has(m)) META.set(m, { family: fam.key, valence: fam.valence, hue: fam.hue, color: fam.color });
  }
}

/** Every emotion in the palette, flat and de-duplicated (lowercase). */
export const EMOTIONS: string[] = [...META.keys()];

/**
 * emotion -> { color, hue, valence, family } so any frontend can colour neurons
 * by feeling. Shared single source of truth for the dashboard server and CLI.
 */
export function emotionPalette(): Record<string, { color: string; hue: number; valence: Valence; family: string }> {
  const p: Record<string, { color: string; hue: number; valence: Valence; family: string }> = {};
  for (const fam of EMOTION_FAMILIES) {
    for (const m of fam.members) if (!p[m]) p[m] = { color: fam.color, hue: fam.hue, valence: fam.valence, family: fam.key };
  }
  return p;
}

/** One swatch per family, valence-ordered, for an emotion legend (excludes plain "neutral"). */
export function emotionFamilyLegend(): Array<{ key: string; color: string; valence: Valence }> {
  const order: Record<string, number> = { positive: 0, ambivalent: 1, neutral: 2, negative: 3 };
  return EMOTION_FAMILIES
    .filter((f) => f.key !== "neutral")
    .map((f) => ({ key: f.key, color: f.color, valence: f.valence }))
    .sort((a, b) => (order[a.valence] ?? 9) - (order[b.valence] ?? 9));
}

/** Look up an emotion's family/valence/hue, or undefined if unknown. */
export function emotionInfo(emotion: string | undefined | null): EmotionInfo | undefined {
  if (!emotion) return undefined;
  return META.get(emotion.trim().toLowerCase());
}

/** Coarse valence for an emotion (defaults to neutral if unrecognised). */
export function emotionValence(emotion: string | undefined | null): Valence {
  return emotionInfo(emotion)?.valence ?? "neutral";
}

/** Whether a label is a recognised palette emotion. */
export function isKnownEmotion(emotion: string): boolean {
  return META.has(emotion.trim().toLowerCase());
}

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
export function affectFromMetadata(metadata: Record<string, unknown> | null | undefined): Affect {
  if (!metadata) return { intensity: 0, valence: "neutral" };
  const inner = (metadata.metadata && typeof metadata.metadata === "object"
    ? metadata.metadata
    : metadata) as Record<string, unknown>;
  const emotion = typeof inner.emotion === "string" && inner.emotion
    ? inner.emotion.trim().toLowerCase()
    : undefined;
  const rawI = inner.emotion_intensity ?? inner.emotionIntensity;
  let intensity = typeof rawI === "number" ? rawI : Number(rawI);
  if (!Number.isFinite(intensity)) intensity = 0;
  intensity = Math.min(1, Math.max(0, intensity > 1 ? intensity / 10 : intensity));
  return { emotion, intensity, valence: emotionValence(emotion) };
}

/**
 * A compact, grouped rendering of the palette for an LLM prompt — families on
 * one line each so the model sees the full range without a giant flat list.
 */
export function emotionPalettePrompt(): string {
  return EMOTION_FAMILIES.map((f) => `  ${f.key}: ${f.members.join(", ")}`).join("\n");
}
