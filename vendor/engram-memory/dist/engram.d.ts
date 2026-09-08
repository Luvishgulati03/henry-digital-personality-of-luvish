import { type EmbeddingProvider } from "./embeddings/provider.js";
import { type LLMProvider } from "./llm/provider.js";
import { type IngestOptions } from "./ingest/markdown.js";
import { type EdgeBuildOptions, type EdgeBuildResult } from "./graph/build.js";
import { type LlmEdgeOptions, type LlmEdgeResult } from "./graph/llm-edges.js";
import { type MemoryTags } from "./enrich/tagging.js";
import { type ConsolidateOptions, type ConsolidateResult } from "./consolidation/consolidate.js";
import { type PromoteOptions, type PromoteResult } from "./consolidation/promote.js";
import type { MemoryStore, StoreStats } from "./store/types.js";
import type { EngramOptions, IndexResult, MemoryInput, RecallOptions, RecallResult, GraphExport, RecallTraceResult } from "./types.js";
export interface IndexOptions extends IngestOptions {
    /** Re-ingested files have their old memories removed first (default true). */
    prune?: boolean;
    /** Wipe the whole index before indexing — a clean full rebuild (default false). */
    fresh?: boolean;
    /**
     * Only embed content that is new or whose content hash changed. Skips
     * re-embedding unchanged chunks — cheap reindex for append-style updates and
     * paid embedders. Deleted files/chunks reconcile on the next full reindex.
     */
    incremental?: boolean;
    /**
     * Rebuild the associative graph after indexing. `true`/omitted uses the
     * default builders (similar + temporal_next); `false` skips graph building;
     * an object tunes the builders. A full index derives edges over the WHOLE
     * store; an incremental index only derives edges for the changed ids.
     */
    edges?: boolean | EdgeBuildOptions;
}
/** Options for the unified `dream()` maintenance cycle. */
export interface DreamOptions {
    /** Promotion pass (short-term → long-term). `false` skips it. */
    promote?: PromoteOptions | false;
    /** Consolidation pass (forget low-salience). `false` skips it. Needs a `capacity` to archive anything. */
    consolidate?: ConsolidateOptions | false;
}
/** What one `dream()` cycle did. Either field is null when its pass was skipped. */
export interface DreamResult {
    promotion: PromoteResult | null;
    consolidation: ConsolidateResult | null;
}
/**
 * Engram — the public memory engine.
 *
 * One object wires a storage backend + an embedding provider + ingestion +
 * hybrid retrieval. The markdown files (or any text you `add`) remain the
 * source of truth; the SQLite index is a derived, rebuildable cache.
 *
 * @example
 * const mem = new Engram({ dbPath: "agent.db" });
 * await mem.indexDirectory("./memories");
 * const hits = await mem.recall("what went wrong last deploy?", { k: 5 });
 * const context = mem.toContextBlock(hits); // inject into your prompt
 */
export declare class Engram {
    readonly store: MemoryStore;
    readonly embedding: EmbeddingProvider;
    /** The configured LLM (subscription CLI), or null for pure hybrid search. */
    readonly llm: LLMProvider | null;
    private readonly defaultK;
    private readonly weights;
    constructor(opts?: EngramOptions);
    /** Store one memory. Returns its id (stable hash of content if not provided). */
    add(input: MemoryInput): Promise<string>;
    /** Store many memories in a single transaction. */
    addMany(inputs: MemoryInput[]): Promise<string[]>;
    private toRecords;
    /**
     * Index a directory of markdown/text files into memories. Non-destructive to
     * the files themselves — the DB is a derived cache that can be rebuilt anytime.
     */
    indexDirectory(dir: string, opts?: IndexOptions): Promise<IndexResult>;
    /** addMany that returns the stored ids (for incremental edge derivation). */
    private addManyResult;
    /**
     * (Re)derive the associative graph over every stored memory — `similar`
     * (embedding kNN) and `temporal_next` (per-source chronology) edges. Cheap,
     * deterministic, offline. Called automatically by `indexDirectory`; expose
     * it for callers who `add()` memories directly and want to refresh the graph.
     */
    buildEdges(opts?: EdgeBuildOptions): EdgeBuildResult;
    /**
     * Derive semantic edges (`caused`, `supersedes`, `lesson_from`) by having the
     * configured LLM classify the graph's already-related pairs. Returns a count
     * of each kind. No-op (zeros) when no LLM is configured. Run after
     * `buildEdges`/`indexDirectory`, since it seeds from the structural edges.
     */
    buildLlmEdges(opts?: LlmEdgeOptions): Promise<LlmEdgeResult>;
    /**
     * Run a consolidation ("dream") pass: cold-archive the lowest-salience
     * memories beyond `capacity` (value-based forgetting; protected tiers exempt).
     * Archived memories drop out of recall but are kept and re-admittable.
     */
    consolidate(opts?: ConsolidateOptions): ConsolidateResult;
    /** Re-admit cold-archived memories back into recall. */
    readmit(ids: string[]): void;
    /**
     * Mark a memory superseded by a newer one (bi-temporal correction). Stamps the
     * older memory's `invalidAt` so recall stops surfacing it as current, and
     * records a `supersedes` edge from the newer memory to the older for the audit
     * trail. Pass `at` to control the timestamp (defaults to now). Idempotent.
     * Use `recall(q, { includeSuperseded: true })` to see superseded facts again.
     */
    supersede(newerId: string, olderId: string, at?: number): void;
    /**
     * Promote proven memories from short-term to long-term: transient (episodic)
     * memories recalled at least `minUseCount` times are flipped to a durable tier
     * (default `semantic`), which `consolidate()` then protects from forgetting.
     * The upward counterpart to `consolidate()`'s downward archiving. Pass
     * `{ dryRun: true }` to rank candidates without changing anything.
     */
    promote(opts?: PromoteOptions): PromoteResult;
    /**
     * One-call nightly maintenance — the whole short-term/long-term cycle. Runs
     * promotion first (so memories that earned long-term status become protected),
     * then consolidation (archive the low-salience remainder). Both passes share a
     * single clock so their recency maths agree.
     *
     * Plug-and-play default: promotion runs; consolidation only archives if you
     * give it a `capacity` (otherwise it's a safe no-op). Pass `false` for either
     * sub-pass to skip it. Schedule this on a cron and forget about it.
     *
     * @example mem.dream({ consolidate: { capacity: 5000 } }); // promote + cap at 5k
     */
    dream(opts?: DreamOptions): DreamResult;
    /**
     * Tag memory texts with structure + emotion + importance + people + topic
     * using the configured LLM (heuristic neutral/episodic fallback without one).
     * Returns one tag set per input, in order. Used to enrich captured memories.
     */
    tagMemories(texts: string[]): Promise<MemoryTags[]>;
    /**
     * Hebbian reinforcement: strengthen edges among a co-used set of memories
     * (e.g. the ids returned by one recall). Returns edges reinforced.
     */
    reinforce(ids: string[], amount?: number): number;
    /**
     * Recall the top-k most relevant memories for a query (hybrid search).
     * With `{ rerank: true }` and an LLM configured, hybrid produces a larger
     * candidate pool that the LLM (your subscription) then reorders by reading the
     * actual text — higher quality, at the cost of one LLM call.
     */
    recall(query: string, opts?: RecallOptions): Promise<RecallResult[]>;
    /**
     * Bayesian-surprise-style novelty of a piece of text: 1 − its maximum cosine
     * similarity to anything already stored (1 = wholly novel, 0 = a duplicate).
     * A cheap, offline importance signal — surprising memories tend to matter.
     * Returns 1 for an empty store (everything is novel at first).
     */
    surprise(content: string): Promise<number>;
    /**
     * Associative recall: hybrid hits seed activation that spreads across the
     * graph, then the two signals are fused. Hybrid hits keep their relevance and
     * gain a lift for inflowing activation; memories reached *only* by spreading
     * enter the results on activation alone — surfacing related context the flat
     * index would miss. Falls back to plain hybrid order when the graph is empty.
     */
    private associativeRecall;
    /**
     * Like `recall({ associative: true })`, but also returns the full activation
     * trace — the seed memories and how much each node was lit up, via which
     * edge. Powers the dashboard's neuron visualisation and any "why did this
     * surface" audit. Always runs in associative mode.
     */
    recallTrace(query: string, opts?: RecallOptions): Promise<RecallTraceResult>;
    /**
     * Export the whole associative graph (nodes + edges + stats) for
     * visualisation. Node content is truncated to a short label to keep the
     * payload light; fetch full content via `recall`/`store.getById` on demand.
     */
    graphExport(opts?: {
        labelChars?: number;
    }): GraphExport;
    /**
     * Rate a memory's long-term importance (0..1) using the configured LLM.
     * Returns 0.5 (neutral) if no LLM is set or the call fails. Opt-in helper for
     * auto-scoring salience at write time.
     */
    rateImportance(text: string): Promise<number>;
    /** Format recall results as a prompt-ready context block for any agent. */
    toContextBlock(results: RecallResult[], opts?: {
        header?: string;
        withSource?: boolean;
    }): string;
    /** Bump recency/frequency counters (used by future consolidation phases). */
    markUsed(ids: string[]): void;
    stats(): StoreStats;
    close(): void;
}
//# sourceMappingURL=engram.d.ts.map