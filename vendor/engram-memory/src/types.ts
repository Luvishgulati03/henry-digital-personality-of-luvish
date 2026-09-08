import type { EmbeddingConfig } from "./embeddings/provider.js";
import type { LLMConfig } from "./llm/provider.js";
import type { SpreadOptions, ActivationProvenance } from "./retrieval/spreading.js";
import type { StoreStats } from "./store/types.js";

/** A memory to be stored. Only `content` is required. */
export interface MemoryInput {
  id?: string;
  content: string;
  source?: string | null;
  tier?: string | null;
  /** Salience. Accepts 0..1 or 1..10 (auto-normalised). Defaults to 0.5. */
  importance?: number;
  metadata?: Record<string, unknown> | null;
  createdAt?: number;
}

/** How the five recall signals are weighted when fusing results. */
export interface RecallWeights {
  /** Weight on the semantic (vector) channel in RRF. */
  semantic: number;
  /** Weight on the lexical (FTS5/bm25) channel in RRF. */
  lexical: number;
  /** Strength of the salience (importance) boost. 0 disables it. */
  importance: number;
  /** Strength of the recency boost. 0 disables it (default). */
  recency: number;
  /**
   * Strength of the frequency boost — memories retrieved often stay sharp
   * (the fifth Generative-Agents term). Scales with a saturating function of
   * `useCount`. 0 disables it.
   */
  frequency: number;
  /**
   * Strength of the affect boost — high-arousal memories are better recalled
   * (the amygdala "save this" flag). Scales with a memory's tagged
   * `emotionIntensity`, valence-agnostic. 0 disables it.
   */
  emotion: number;
  /**
   * Weight on graph-spread activation — the association signal (Phase 2). Only
   * applies when recall runs in `associative` mode; scales how much a memory's
   * received activation lifts (or creates) its score.
   */
  activation: number;
  /** Reciprocal-Rank-Fusion constant. Larger = flatter rank influence. */
  rrfK: number;
  /** Half-life in days for the recency boost. */
  recencyHalfLifeDays: number;
}

export interface EngramOptions {
  /** SQLite file path, or ":memory:" for an ephemeral index. */
  dbPath?: string;
  /** Embedding provider or config. Defaults to the offline hashing provider. */
  embedding?: EmbeddingConfig;
  /**
   * Optional LLM (subscription CLI: claude/codex, or custom) used for reranking
   * and importance scoring. Omit to run in pure hybrid-search mode.
   */
  llm?: LLMConfig;
  defaultK?: number;
  weights?: Partial<RecallWeights>;
}

export interface RecallOptions {
  k?: number;
  weights?: Partial<RecallWeights>;
  /** Restrict to a single tier (episodic/semantic/procedural/...). */
  tier?: string;
  /** Include cold-archived memories (Phase 3). Default false. */
  includeArchived?: boolean;
  /**
   * Include superseded (stale) memories — those with `invalidAt` set. Default
   * false, so corrected facts never surface as current. Set true for explicitly
   * historical queries ("what did we believe last week?").
   */
  includeSuperseded?: boolean;
  /**
   * Hebbian reinforcement (Phase 4): after recall, strengthen the edges among
   * the returned memories so frequently co-retrieved memories cluster. Default
   * false. Best paired with markUsed.
   */
  reinforce?: boolean;
  /** Bump recency/use-count counters on the returned memories (default false). */
  markUsed?: boolean;
  /** Candidates pulled from each channel before fusion (default 50). */
  candidatePool?: number;
  /** Rerank hybrid candidates with the configured LLM. No-op if no LLM is set. */
  rerank?: boolean;
  /** How many hybrid candidates to hand the reranker (default max(k*4, 20)). */
  rerankPool?: number;
  /**
   * Run associative recall: seed activation at the hybrid hits and spread it
   * across the graph, surfacing related memories that share no words/vectors
   * with the query. No-op (falls back to hybrid) if the graph has no edges.
   */
  associative?: boolean;
  /** Tune the spreading-activation diffusion (decay, hops, edge types). */
  spread?: SpreadOptions;
  /**
   * In associative mode, also seed activation at memories tagged (in the
   * glossary) with an entity the query mentions — precise, topic-level recall.
   * Default true; no-op when the glossary is empty.
   */
  entitySeeding?: boolean;
}

export interface RecallResult {
  id: string;
  content: string;
  source: string | null;
  tier: string | null;
  importance: number;
  /** Final fused score (higher = better). */
  score: number;
  scores: { semantic?: number; lexical?: number; rrf: number; activation?: number; frequency?: number; emotion?: number };
  ranks: { semantic?: number; lexical?: number };
  metadata: Record<string, unknown> | null;
  /** Human-readable explanation of why this memory surfaced (the "audit" trace). */
  why: string;
}

export interface IndexResult {
  directory: string;
  files: number;
  memories: number;
  /** Rows removed because their source file was re-ingested (full index only). */
  pruned: number;
  /** Chunks left untouched because they were already stored and unchanged (incremental only). */
  skipped: number;
  durationMs: number;
  embeddingModel: string;
}

// --- Graph export + recall trace (for visualisation / audit) ----------------

export interface GraphNode {
  id: string;
  /** Truncated content preview (full text omitted to keep exports light). */
  label: string;
  tier: string | null;
  importance: number;
  source: string | null;
  useCount: number;
  /** Cold-archived by consolidation (Phase 3). */
  archived: boolean;
  /** Consolidation salience (recency × frequency × importance blend). */
  salience: number;
  /** Emotional tone tag, if the memory was enriched (e.g. "frustrated"). */
  emotion?: string;
  /** Emotional intensity 0..1. */
  emotionIntensity?: number;
  /** Topic tag, if enriched. */
  topic?: string;
}

export interface GraphEdgeView {
  src: string;
  dst: string;
  type: string;
  weight: number;
}

/** The whole associative graph, ready to render. */
export interface GraphExport {
  nodes: GraphNode[];
  edges: GraphEdgeView[];
  stats: StoreStats;
}

export interface TraceSeed {
  id: string;
  /** Initial activation injected at this seed. */
  score: number;
  /** How it was chosen as a seed. */
  kind: "hybrid" | "entity";
  /** For entity seeds: which query entity matched. */
  entity?: string;
}

export interface TraceActivation {
  id: string;
  activation: number;
  via: ActivationProvenance;
}

/** Everything needed to animate a recall: where it started and how it spread. */
export interface AssociativeTrace {
  query: string;
  seeds: TraceSeed[];
  activations: TraceActivation[];
}

export interface RecallTraceResult {
  results: RecallResult[];
  trace: AssociativeTrace;
}
