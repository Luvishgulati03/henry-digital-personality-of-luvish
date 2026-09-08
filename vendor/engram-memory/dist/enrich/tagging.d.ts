/**
 * Memory tagging — structured + emotional metadata for each memory.
 *
 * A raw captured exchange is just text. To store it the way a brain does, we
 * tag it: what KIND of memory is it (episodic event vs semantic fact vs
 * procedural how-to — the structure/tier), how IMPORTANT is it, what EMOTION
 * does it carry and how strongly, what's it ABOUT, and WHO is involved. Those
 * tags drive the short/long-term split, salience-based consolidation, and
 * affect-aware recall.
 *
 * Tagging uses the configured LLM (the user's subscription CLI). Without an LLM,
 * a safe heuristic fallback keeps everything working (episodic, neutral).
 */
import type { LLMProvider } from "../llm/provider.js";
export interface MemoryTags {
    /** Structure: episodic (an event), semantic (a durable fact/rule), procedural (a how-to), working (transient). */
    tier: "episodic" | "semantic" | "procedural" | "working";
    /** Long-term importance 0..1. */
    importance: number;
    /** Emotional tone — one word from the emotion palette (see `EMOTIONS`), e.g. "frustrated", "pride", "relief". */
    emotion: string;
    /** Emotional intensity 0..1. */
    emotionIntensity: number;
    /** 1–3 word topic label. */
    topic: string;
    /** People/handles involved (lowercase, no @). */
    people: string[];
    /** One concise sentence capturing the gist. */
    summary: string;
    /**
     * Set when the LLM was unavailable/failed and this is the neutral fallback,
     * NOT a real judgment. Callers running a salience gate must not treat these
     * scores as "judged unimportant" — the fallback's low scores would silently
     * fail the gate and the memory would be lost.
     */
    llmFailed?: true;
}
/** Extract the first JSON array from an LLM reply (balanced-bracket scan). */
export declare function parseTags(resp: string): Record<string, unknown>[];
/**
 * Tag a batch of memory texts. Returns one MemoryTags per input (order
 * preserved). Falls back to neutral/episodic for any item on LLM failure or a
 * short/empty reply — tagging never blocks capture.
 */
export declare function tagMemories(llm: LLMProvider | null, texts: string[]): Promise<MemoryTags[]>;
//# sourceMappingURL=tagging.d.ts.map