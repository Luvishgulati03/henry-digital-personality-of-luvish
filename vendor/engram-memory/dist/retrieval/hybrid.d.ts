import type { MemoryStore } from "../store/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { RecallOptions, RecallResult, RecallWeights } from "../types.js";
export declare const DEFAULT_WEIGHTS: RecallWeights;
/**
 * Hybrid recall = two channels fused with Reciprocal Rank Fusion (RRF), then
 * nudged by salience (importance) and optionally recency.
 *
 *  1. SEMANTIC: cosine of the query embedding against every stored vector.
 *  2. LEXICAL:  FTS5/bm25 keyword match.
 *
 * RRF is used because the two channels produce incomparable raw scores (cosine
 * vs bm25); fusing by *rank* (score += w / (rrfK + rank)) is robust and needs
 * no score normalisation. Convergent evidence — a memory ranking high in both
 * channels — accumulates, which is exactly the behaviour we want.
 */
export declare function recall(store: MemoryStore, provider: EmbeddingProvider, query: string, opts: RecallOptions, baseWeights: RecallWeights): Promise<RecallResult[]>;
//# sourceMappingURL=hybrid.d.ts.map