/**
 * LLM-derived semantic edges — the relationships you can't get from vectors or
 * timestamps alone: `caused`, `supersedes`, `lesson_from`.
 *
 * The structural builders (`similar`, `temporal_next`, `about`) already tell us
 * which memories are *related*. This pass asks the LLM (the user's subscription
 * CLI — no API key) to read those related pairs and label the relationship's
 * KIND and DIRECTION. We only consider pairs that already share a structural
 * edge, so the LLM never sees an O(n²) explosion — just the graph's existing
 * neighbourhoods, in batches, capped.
 *
 * Failure is always safe: a timeout, an unparseable reply, or a thrown CLI
 * error simply yields fewer edges, never a crash and never a wrong edge.
 * Requires an LLM; a no-LLM caller gets an empty result.
 */
import type { EdgeType, MemoryStore } from "../store/types.js";
import type { LLMProvider } from "../llm/provider.js";
export interface LlmEdgeOptions {
    /** Max candidate pairs to classify (caps LLM cost). Default 80. */
    maxPairs?: number;
    /** Pairs per LLM call. Default 8. */
    batchSize?: number;
    /** Chars of each memory shown to the LLM. Default 280. */
    snippetChars?: number;
    /** Weight for created edges. Default 0.85. */
    weight?: number;
    /** Which structural edge types seed the candidate pairs. Default similar + temporal_next. */
    candidateTypes?: EdgeType[];
}
export interface LlmEdgeResult {
    caused: number;
    supersedes: number;
    lesson_from: number;
    pairsConsidered: number;
    calls: number;
}
interface Labelled {
    pair: number;
    rel: string;
    dir?: string;
}
/** Extract the first JSON array of {pair,rel,dir} objects from an LLM reply. */
export declare function parseRelations(resp: string): Labelled[];
/**
 * Classify the graph's related pairs into semantic edges with an LLM.
 * Idempotent (edges upsert); safe to re-run.
 */
export declare function buildLlmEdges(store: MemoryStore, llm: LLMProvider, opts?: LlmEdgeOptions): Promise<LlmEdgeResult>;
export {};
//# sourceMappingURL=llm-edges.d.ts.map