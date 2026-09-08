import Database from "better-sqlite3";
import type { EdgeType, MemoryEdge, MemoryRecord, MemoryStore, ScoredId, StoreStats } from "./types.js";
/**
 * Build a safe FTS5 MATCH expression from free-form text. Stopwords are dropped
 * (same tokeniser as the embedder) so bm25 ranks on content-bearing terms.
 * Returns null when nothing meaningful remains.
 */
export declare function toFtsQuery(query: string): string | null;
export declare class SqliteStore implements MemoryStore {
    readonly db: Database.Database;
    readonly dbPath: string;
    constructor(dbPath?: string);
    private migrate;
    upsert(rec: MemoryRecord): void;
    upsertMany(recs: MemoryRecord[]): void;
    getById(id: string): MemoryRecord | undefined;
    getByIds(ids: string[]): MemoryRecord[];
    deleteBySourcePrefix(prefix: string): number;
    clear(): void;
    ftsSearch(query: string, limit: number): ScoredId[];
    allVectors(): Array<{
        id: string;
        embedding: Float32Array;
        dim: number;
    }>;
    allRecords(): MemoryRecord[];
    count(): number;
    markUsed(ids: string[]): void;
    setArchived(ids: string[], archived: boolean): void;
    setInvalidAt(ids: string[], at: number | null): void;
    addEdge(edge: MemoryEdge): void;
    addEdges(edges: MemoryEdge[]): void;
    edgesFrom(ids: string[], types?: EdgeType[]): MemoryEdge[];
    edgesFor(id: string): MemoryEdge[];
    allEdges(): MemoryEdge[];
    deleteEdgesFor(ids: string[]): number;
    deleteEdgesByType(types: EdgeType[]): number;
    edgeCount(): number;
    setEntities(memoryId: string, entities: string[]): void;
    memoriesForEntity(entity: string): string[];
    entityLinks(): Array<{
        entity: string;
        memoryId: string;
    }>;
    entityCount(): number;
    stats(): StoreStats;
    close(): void;
}
//# sourceMappingURL=sqlite-store.d.ts.map