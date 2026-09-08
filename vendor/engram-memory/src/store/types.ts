/**
 * Storage-layer types and the MemoryStore contract.
 *
 * The store is deliberately dumb: it persists records and answers two kinds of
 * primitive queries — lexical (FTS5) and "give me every vector". All ranking
 * and fusion lives one layer up in `retrieval/`. This keeps the store swappable
 * (SQLite today, Postgres/Redis tomorrow) without touching recall logic.
 */

export type Tier = "episodic" | "semantic" | "procedural" | "working" | (string & {});

/**
 * The typed, weighted relationships that turn independent memories into an
 * associative graph (Phase 2). Some are directed (`caused`, `temporal_next`,
 * `supersedes`, `lesson_from`), some symmetric (`similar`, `about`); symmetric
 * relations are stored as a pair of directed edges so traversal stays uniform.
 *
 *  - `similar`        — high embedding cosine (auto, offline kNN at index time)
 *  - `temporal_next`  — the next memory in time within one source/session
 *  - `about`          — shares a salient entity (via the glossary)
 *  - `caused`         — A led to / explains B
 *  - `supersedes`     — A replaces/corrects an older B
 *  - `lesson_from`    — a general lesson distilled from a concrete episode
 */
export type EdgeType =
  | "similar"
  | "temporal_next"
  | "about"
  | "caused"
  | "supersedes"
  | "lesson_from"
  | (string & {});

/** A directed, weighted edge between two memories. */
export interface MemoryEdge {
  srcId: string;
  dstId: string;
  type: EdgeType;
  /** Relationship strength in (0,1]. Drives how much activation flows across it. */
  weight: number;
  createdAt: number;
  updatedAt: number;
}

/** A fully-materialised memory as it lives in storage. */
export interface MemoryRecord {
  id: string;
  content: string;
  source: string | null;
  tier: Tier | null;
  /** Salience in [0,1]. Drives optional ranking boosts now; central in Phase 2+. */
  importance: number;
  metadata: Record<string, unknown> | null;
  /** sha256 of `content`; lets re-indexing skip unchanged rows. */
  contentHash: string;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  useCount: number;
  /**
   * Cold-archived by consolidation (Phase 3). Archived memories are excluded
   * from recall by default but never hard-deleted — re-admitted on a later hit.
   */
  archived: boolean;
  /**
   * Bi-temporal validity (Zep-style). `validAt` is when the fact became true
   * (defaults to creation); `invalidAt` is set when a newer memory supersedes/
   * corrects it. A non-null `invalidAt` means the fact is stale — excluded from
   * recall by default so engram never surfaces a corrected fact as current.
   */
  validAt: number | null;
  invalidAt: number | null;
  embedding: Float32Array | null;
  embeddingModel: string | null;
  embeddingDim: number | null;
}

/** A single lexical (FTS) or vector hit. Lower-is-better for bm25; cosine is 0..1. */
export interface ScoredId {
  id: string;
  score: number;
}

export interface StoreStats {
  count: number;
  withEmbedding: number;
  tiers: Record<string, number>;
  sources: number;
  /** Total directed edges in the associative graph (Phase 2). */
  edges: number;
  /** Distinct entities in the glossary inverted index (Phase 2). */
  entities: number;
  dbPath: string;
}

/**
 * The backend contract. Implement this to put engram on a different database.
 * Methods are synchronous because SQLite (better-sqlite3) is synchronous; an
 * async backend can wrap these in promises behind the same shape.
 */
export interface MemoryStore {
  upsert(rec: MemoryRecord): void;
  upsertMany(recs: MemoryRecord[]): void;
  getById(id: string): MemoryRecord | undefined;
  getByIds(ids: string[]): MemoryRecord[];
  /** Remove every memory whose `source` starts with `prefix`. Returns rows deleted. */
  deleteBySourcePrefix(prefix: string): number;
  clear(): void;
  /** Lexical search via FTS5/bm25. Returns ids best-first. */
  ftsSearch(query: string, limit: number): ScoredId[];
  /** Every stored embedding. Phase-1 vector search scans these in JS. */
  allVectors(): Array<{ id: string; embedding: Float32Array; dim: number }>;
  /** Every memory record (full scan). Used by graph construction / consolidation. */
  allRecords(): MemoryRecord[];
  count(): number;
  /** Bump recency/frequency counters for the given ids. */
  markUsed(ids: string[]): void;
  /** Set the cold-archive flag for the given ids (Phase 3 consolidation). */
  setArchived(ids: string[], archived: boolean): void;
  /**
   * Stamp (or clear, with `null`) the `invalid_at` timestamp on the given ids —
   * how a memory is marked superseded/stale (bi-temporal supersession).
   */
  setInvalidAt(ids: string[], at: number | null): void;
  stats(): StoreStats;
  close(): void;

  // --- Associative graph (Phase 2) -----------------------------------------
  /** Insert or update one edge (upsert on the (src,dst,type) key). */
  addEdge(edge: MemoryEdge): void;
  /** Insert/update many edges in a single transaction. */
  addEdges(edges: MemoryEdge[]): void;
  /**
   * Out-edges leaving any of `ids` — the frontier for spreading activation.
   * `types` optionally restricts to specific relationship kinds.
   */
  edgesFrom(ids: string[], types?: EdgeType[]): MemoryEdge[];
  /** Every edge incident to `id` in either direction (for inspection/audit). */
  edgesFor(id: string): MemoryEdge[];
  /** All edges in the graph (for export / visualisation). */
  allEdges(): MemoryEdge[];
  /** Remove every edge touching any of `ids` (either endpoint). Returns rows deleted. */
  deleteEdgesFor(ids: string[]): number;
  /** Remove every edge of the given types (used to prune derived edges before a rebuild). */
  deleteEdgesByType(types: EdgeType[]): number;
  edgeCount(): number;

  // --- Entity glossary (Phase 2) -------------------------------------------
  /** Replace the set of entities attached to one memory in the inverted index. */
  setEntities(memoryId: string, entities: string[]): void;
  /** Memory ids tagged with a given entity (case-insensitive key). */
  memoriesForEntity(entity: string): string[];
  /** Every (entity, memoryId) pair — used to build `about` edges in bulk. */
  entityLinks(): Array<{ entity: string; memoryId: string }>;
  /** Count of distinct entities in the glossary. */
  entityCount(): number;
}
