/**
 * Automatic edge construction — turns a flat set of memories into an
 * associative graph using only signals already in the store (no LLM, no
 * network), in keeping with engram's zero-friction default.
 *
 * Two deterministic builders ship here:
 *
 *  - `similar`        — k-nearest-neighbour over embeddings. For each memory we
 *                       link to its top-k most cosine-similar peers above a
 *                       threshold. Edge weight = the cosine itself, so stronger
 *                       resemblances carry more activation later.
 *  - `temporal_next`  — within one source (a day-log, a session) memories form a
 *                       chain in creation order: each links to the one that
 *                       immediately followed it. This is what lets recall walk
 *                       "what happened next" even when the next note shares no
 *                       words with the query.
 *
 * Both are idempotent: edges upsert on (src,dst,type), and a reindex prunes a
 * file's old memories (cascading their edges) before re-adding, so rebuilding
 * never accumulates stale links. Richer edge types (caused / supersedes /
 * lesson_from) are LLM- or frontmatter-derived and live in later increments.
 */
import type { MemoryStore } from "../store/types.js";
export interface SimilarEdgeOptions {
    /** Max similar neighbours linked per memory (default 5). */
    k?: number;
    /** Minimum cosine similarity to create an edge (default 0.5). */
    minSimilarity?: number;
}
export interface AboutEdgeOptions {
    /**
     * Skip entities appearing in more than this many memories — they're too
     * common to be a meaningful shared topic and would create dense noise.
     * Default 8 (tuned down from 25: common terms otherwise flood the graph and
     * over-spread activation at recall time).
     */
    maxDocFreq?: number;
}
export interface EdgeBuildOptions {
    /** Build `similar` edges from embedding kNN. `true` uses defaults. Default on. */
    similar?: boolean | SimilarEdgeOptions;
    /** Build `temporal_next` edges within each source. Default on. */
    temporal?: boolean;
    /**
     * Populate the entity glossary and build `about` edges between memories that
     * share a salient entity. `true` uses defaults. Default on.
     */
    about?: boolean | AboutEdgeOptions;
    /**
     * Incremental mode: only derive edges involving these (new/changed) memory
     * ids — O(m·n) instead of the full O(n²) rebuild, which matters when a
     * single captured memory triggers a reindex. Upsert-only (no prune), so a
     * periodic full rebuild still reconciles edges whose derivation drifted.
     */
    onlyIds?: string[];
}
export interface EdgeBuildResult {
    similar: number;
    temporal: number;
    about: number;
    total: number;
}
/**
 * (Re)derive automatic edges over every memory currently in the store.
 * Returns how many edges of each kind were written.
 */
export declare function buildEdges(store: MemoryStore, opts?: EdgeBuildOptions): EdgeBuildResult;
//# sourceMappingURL=build.d.ts.map