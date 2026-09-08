import Database from "better-sqlite3";
import { meaningfulTokens } from "../util/text.js";
/**
 * SQLite-backed store. One file = the whole memory index.
 *
 * Design notes:
 *  - `memory` is the source of truth for records + embeddings (stored as BLOBs).
 *  - `memory_fts` is an FTS5 mirror of `content`, kept in sync inside `upsert`.
 *  - Embeddings live as little-endian Float32 BLOBs. At Phase-1 scale (thousands
 *    of rows) we scan them in JS for cosine similarity; swapping in sqlite-vec is
 *    a drop-in optimisation behind this same interface (see docs/paper/05).
 */
// --- Float32Array <-> BLOB helpers -----------------------------------------
function encodeVec(v) {
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function decodeVec(b) {
    // Copy into a fresh, 0-offset ArrayBuffer so Float32Array alignment is safe.
    const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
    return new Float32Array(ab);
}
/**
 * Build a safe FTS5 MATCH expression from free-form text. Stopwords are dropped
 * (same tokeniser as the embedder) so bm25 ranks on content-bearing terms.
 * Returns null when nothing meaningful remains.
 */
export function toFtsQuery(query) {
    const unique = [...new Set(meaningfulTokens(query))];
    if (unique.length === 0)
        return null;
    // Quote each term to neutralise FTS operators, OR them together.
    return unique.map((t) => `"${t}"`).join(" OR ");
}
function rowToEdge(r) {
    return {
        srcId: r.src_id,
        dstId: r.dst_id,
        type: r.type,
        weight: r.weight,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
    };
}
function rowToRecord(r) {
    return {
        id: r.id,
        content: r.content,
        source: r.source,
        tier: r.tier,
        importance: r.importance,
        metadata: r.metadata ? JSON.parse(r.metadata) : null,
        contentHash: r.content_hash,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        lastUsedAt: r.last_used_at,
        useCount: r.use_count,
        archived: !!r.archived,
        validAt: r.valid_at,
        invalidAt: r.invalid_at,
        embedding: r.embedding ? decodeVec(r.embedding) : null,
        embeddingModel: r.embedding_model,
        embeddingDim: r.embedding_dim,
    };
}
export class SqliteStore {
    db;
    dbPath;
    constructor(dbPath = "engram.db") {
        this.dbPath = dbPath;
        this.db = new Database(dbPath);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("synchronous = NORMAL");
        // Concurrent readers/writers (CLI indexing while a dashboard reads) wait for
        // the lock instead of failing fast with SQLITE_BUSY.
        this.db.pragma("busy_timeout = 5000");
        this.migrate();
    }
    migrate() {
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS memory (
        id            TEXT PRIMARY KEY,
        content       TEXT NOT NULL,
        source        TEXT,
        tier          TEXT,
        importance    REAL NOT NULL DEFAULT 0.5,
        metadata      TEXT,
        content_hash  TEXT NOT NULL,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        last_used_at  INTEGER,
        use_count     INTEGER NOT NULL DEFAULT 0,
        archived      INTEGER NOT NULL DEFAULT 0,
        valid_at      INTEGER,
        invalid_at    INTEGER,
        embedding     BLOB,
        embedding_model TEXT,
        embedding_dim INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memory_source ON memory(source);
      CREATE INDEX IF NOT EXISTS idx_memory_tier ON memory(tier);

      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
        id UNINDEXED,
        content,
        tokenize = 'porter unicode61'
      );

      -- Associative graph: directed, weighted edges between memories (Phase 2).
      -- (src_id, dst_id, type) is unique so re-deriving edges upserts weights.
      CREATE TABLE IF NOT EXISTS edge (
        src_id     TEXT NOT NULL,
        dst_id     TEXT NOT NULL,
        type       TEXT NOT NULL,
        weight     REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (src_id, dst_id, type)
      );
      CREATE INDEX IF NOT EXISTS idx_edge_src ON edge(src_id);
      CREATE INDEX IF NOT EXISTS idx_edge_dst ON edge(dst_id);

      -- Entity glossary: inverted index from a salient term to the memories it
      -- appears in (Phase 2). Drives about-edges and query-entity seeding.
      -- Keys are stored lowercased for case-insensitive lookup.
      CREATE TABLE IF NOT EXISTS entity (
        entity     TEXT NOT NULL,
        memory_id  TEXT NOT NULL,
        PRIMARY KEY (entity, memory_id)
      );
      CREATE INDEX IF NOT EXISTS idx_entity_entity ON entity(entity);
      CREATE INDEX IF NOT EXISTS idx_entity_memory ON entity(memory_id);
    `);
        // Additive migrations for DBs created before a column existed.
        const cols = this.db.prepare(`PRAGMA table_info(memory)`).all();
        const has = (name) => cols.some((c) => c.name === name);
        if (!has("archived")) {
            this.db.exec(`ALTER TABLE memory ADD COLUMN archived INTEGER NOT NULL DEFAULT 0`);
        }
        if (!has("valid_at"))
            this.db.exec(`ALTER TABLE memory ADD COLUMN valid_at INTEGER`);
        if (!has("invalid_at"))
            this.db.exec(`ALTER TABLE memory ADD COLUMN invalid_at INTEGER`);
    }
    upsert(rec) {
        const insertMem = this.db.prepare(`
      INSERT INTO memory (id, content, source, tier, importance, metadata, content_hash,
                          created_at, updated_at, last_used_at, use_count,
                          valid_at, invalid_at,
                          embedding, embedding_model, embedding_dim)
      VALUES (@id, @content, @source, @tier, @importance, @metadata, @content_hash,
              @created_at, @updated_at, @last_used_at, @use_count,
              @valid_at, @invalid_at,
              @embedding, @embedding_model, @embedding_dim)
      ON CONFLICT(id) DO UPDATE SET
        content=excluded.content, source=excluded.source, tier=excluded.tier,
        importance=excluded.importance, metadata=excluded.metadata,
        content_hash=excluded.content_hash, updated_at=excluded.updated_at,
        embedding=excluded.embedding, embedding_model=excluded.embedding_model,
        embedding_dim=excluded.embedding_dim
        -- valid_at / invalid_at deliberately preserved across reindex (like
        -- created_at): supersession state must survive a content re-embed.
    `);
        insertMem.run({
            id: rec.id,
            content: rec.content,
            source: rec.source,
            tier: rec.tier,
            importance: rec.importance,
            metadata: rec.metadata ? JSON.stringify(rec.metadata) : null,
            content_hash: rec.contentHash,
            created_at: rec.createdAt,
            updated_at: rec.updatedAt,
            last_used_at: rec.lastUsedAt,
            use_count: rec.useCount,
            valid_at: rec.validAt,
            invalid_at: rec.invalidAt,
            embedding: rec.embedding ? encodeVec(rec.embedding) : null,
            embedding_model: rec.embeddingModel,
            embedding_dim: rec.embeddingDim,
        });
        // keep FTS mirror in sync
        this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(rec.id);
        this.db.prepare(`INSERT INTO memory_fts (id, content) VALUES (?, ?)`).run(rec.id, rec.content);
    }
    upsertMany(recs) {
        const tx = this.db.transaction((rows) => {
            for (const r of rows)
                this.upsert(r);
        });
        tx(recs);
    }
    getById(id) {
        const row = this.db.prepare(`SELECT * FROM memory WHERE id = ?`).get(id);
        return row ? rowToRecord(row) : undefined;
    }
    getByIds(ids) {
        if (ids.length === 0)
            return [];
        const placeholders = ids.map(() => "?").join(",");
        const rows = this.db
            .prepare(`SELECT * FROM memory WHERE id IN (${placeholders})`)
            .all(...ids);
        return rows.map(rowToRecord);
    }
    deleteBySourcePrefix(prefix) {
        // Escape LIKE wildcards in the prefix so a literal `_`/`%` in a file path
        // (notes_1.md) can't over-match unrelated sources (notesX1.md).
        const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
        const ids = this.db
            .prepare(`SELECT id FROM memory WHERE source = ? OR source LIKE ? ESCAPE '\\'`)
            .all(prefix, `${escaped}%`);
        const tx = this.db.transaction((rows) => {
            for (const { id } of rows) {
                this.db.prepare(`DELETE FROM memory WHERE id = ?`).run(id);
                this.db.prepare(`DELETE FROM memory_fts WHERE id = ?`).run(id);
                // Cascade: drop any edges/entities touching this memory so the graph
                // has no dangling endpoints. Both are re-derived on reindex.
                this.db.prepare(`DELETE FROM edge WHERE src_id = ? OR dst_id = ?`).run(id, id);
                this.db.prepare(`DELETE FROM entity WHERE memory_id = ?`).run(id);
            }
        });
        tx(ids);
        return ids.length;
    }
    clear() {
        this.db.exec(`DELETE FROM memory; DELETE FROM memory_fts; DELETE FROM edge; DELETE FROM entity;`);
    }
    ftsSearch(query, limit) {
        const match = toFtsQuery(query);
        if (!match)
            return [];
        const rows = this.db
            .prepare(`SELECT id, bm25(memory_fts) AS score
         FROM memory_fts WHERE memory_fts MATCH ?
         ORDER BY score ASC LIMIT ?`)
            .all(match, limit);
        return rows.map((r) => ({ id: r.id, score: r.score }));
    }
    allVectors() {
        const rows = this.db
            .prepare(`SELECT id, embedding, embedding_dim FROM memory WHERE embedding IS NOT NULL`)
            .all();
        return rows.map((r) => ({ id: r.id, embedding: decodeVec(r.embedding), dim: r.embedding_dim }));
    }
    allRecords() {
        const rows = this.db.prepare(`SELECT * FROM memory`).all();
        return rows.map(rowToRecord);
    }
    count() {
        return this.db.prepare(`SELECT COUNT(*) AS n FROM memory`).get().n;
    }
    markUsed(ids) {
        if (ids.length === 0)
            return;
        const now = Date.now();
        const stmt = this.db.prepare(`UPDATE memory SET last_used_at = ?, use_count = use_count + 1 WHERE id = ?`);
        const tx = this.db.transaction((rows) => {
            for (const id of rows)
                stmt.run(now, id);
        });
        tx(ids);
    }
    setArchived(ids, archived) {
        if (ids.length === 0)
            return;
        const ph = ids.map(() => "?").join(",");
        this.db.prepare(`UPDATE memory SET archived = ? WHERE id IN (${ph})`).run(archived ? 1 : 0, ...ids);
    }
    setInvalidAt(ids, at) {
        if (ids.length === 0)
            return;
        const ph = ids.map(() => "?").join(",");
        this.db.prepare(`UPDATE memory SET invalid_at = ? WHERE id IN (${ph})`).run(at, ...ids);
    }
    // --- Associative graph (Phase 2) -----------------------------------------
    addEdge(edge) {
        this.db
            .prepare(`INSERT INTO edge (src_id, dst_id, type, weight, created_at, updated_at)
         VALUES (@src_id, @dst_id, @type, @weight, @created_at, @updated_at)
         ON CONFLICT(src_id, dst_id, type) DO UPDATE SET
           weight=excluded.weight, updated_at=excluded.updated_at`)
            .run({
            src_id: edge.srcId,
            dst_id: edge.dstId,
            type: edge.type,
            weight: edge.weight,
            created_at: edge.createdAt,
            updated_at: edge.updatedAt,
        });
    }
    addEdges(edges) {
        const tx = this.db.transaction((rows) => {
            for (const e of rows)
                this.addEdge(e);
        });
        tx(edges);
    }
    edgesFrom(ids, types) {
        if (ids.length === 0)
            return [];
        const idPh = ids.map(() => "?").join(",");
        let sql = `SELECT * FROM edge WHERE src_id IN (${idPh})`;
        const params = [...ids];
        if (types && types.length > 0) {
            sql += ` AND type IN (${types.map(() => "?").join(",")})`;
            params.push(...types);
        }
        const rows = this.db.prepare(sql).all(...params);
        return rows.map(rowToEdge);
    }
    edgesFor(id) {
        const rows = this.db
            .prepare(`SELECT * FROM edge WHERE src_id = ? OR dst_id = ?`)
            .all(id, id);
        return rows.map(rowToEdge);
    }
    allEdges() {
        const rows = this.db.prepare(`SELECT * FROM edge`).all();
        return rows.map(rowToEdge);
    }
    deleteEdgesFor(ids) {
        if (ids.length === 0)
            return 0;
        const ph = ids.map(() => "?").join(",");
        const info = this.db
            .prepare(`DELETE FROM edge WHERE src_id IN (${ph}) OR dst_id IN (${ph})`)
            .run(...ids, ...ids);
        return info.changes;
    }
    deleteEdgesByType(types) {
        if (types.length === 0)
            return 0;
        const ph = types.map(() => "?").join(",");
        const info = this.db.prepare(`DELETE FROM edge WHERE type IN (${ph})`).run(...types);
        return info.changes;
    }
    edgeCount() {
        return this.db.prepare(`SELECT COUNT(*) AS n FROM edge`).get().n;
    }
    // --- Entity glossary (Phase 2) -------------------------------------------
    setEntities(memoryId, entities) {
        const tx = this.db.transaction((ents) => {
            this.db.prepare(`DELETE FROM entity WHERE memory_id = ?`).run(memoryId);
            const ins = this.db.prepare(`INSERT OR IGNORE INTO entity (entity, memory_id) VALUES (?, ?)`);
            for (const e of ents) {
                const key = e.trim().toLowerCase();
                if (key)
                    ins.run(key, memoryId);
            }
        });
        tx([...new Set(entities)]);
    }
    memoriesForEntity(entity) {
        const rows = this.db
            .prepare(`SELECT memory_id FROM entity WHERE entity = ?`)
            .all(entity.trim().toLowerCase());
        return rows.map((r) => r.memory_id);
    }
    entityLinks() {
        const rows = this.db.prepare(`SELECT entity, memory_id FROM entity`).all();
        return rows.map((r) => ({ entity: r.entity, memoryId: r.memory_id }));
    }
    entityCount() {
        return this.db.prepare(`SELECT COUNT(DISTINCT entity) AS n FROM entity`).get().n;
    }
    stats() {
        const count = this.count();
        const withEmbedding = this.db.prepare(`SELECT COUNT(*) AS n FROM memory WHERE embedding IS NOT NULL`).get().n;
        const sources = this.db.prepare(`SELECT COUNT(DISTINCT source) AS n FROM memory WHERE source IS NOT NULL`).get().n;
        const tierRows = this.db
            .prepare(`SELECT COALESCE(tier,'(none)') AS tier, COUNT(*) AS n FROM memory GROUP BY tier`)
            .all();
        const tiers = {};
        for (const t of tierRows)
            tiers[t.tier] = t.n;
        return {
            count,
            withEmbedding,
            tiers,
            sources,
            edges: this.edgeCount(),
            entities: this.entityCount(),
            dbPath: this.dbPath,
        };
    }
    close() {
        this.db.close();
    }
}
//# sourceMappingURL=sqlite-store.js.map