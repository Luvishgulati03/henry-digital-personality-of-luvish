/**
 * Storage-layer types and the MemoryStore contract.
 *
 * The store is deliberately dumb: it persists records and answers two kinds of
 * primitive queries — lexical (FTS5) and "give me every vector". All ranking
 * and fusion lives one layer up in `retrieval/`. This keeps the store swappable
 * (SQLite today, Postgres/Redis tomorrow) without touching recall logic.
 */
export {};
//# sourceMappingURL=types.js.map