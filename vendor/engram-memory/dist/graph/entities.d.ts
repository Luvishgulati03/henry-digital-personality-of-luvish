/**
 * Offline entity extraction — the cheap, deterministic glossary builder.
 *
 * "Entities" here are the salient nouns a memory is *about*: proper names
 * (Ada Lovelace, Socket Mode), acronyms (API, MCP), and code identifiers
 * (`relevance_score`, conversations.replies, sqlite-vec). They are the hooks
 * two otherwise-dissimilar memories share — "the deploy that broke the
 * `relevance_score` column" and "added a migration for `relevance_score`" have
 * little lexical overlap but are obviously *about* the same thing. Linking on
 * shared entities (`about` edges) and seeding recall from a query's entities is
 * what the roadmap calls precise, glossary-driven association.
 *
 * This is intentionally high-precision over high-recall: we'd rather miss a
 * fuzzy entity than flood the graph with noise edges. Richer NER can be swapped
 * in later (an LLM pass), but the default stays zero-dependency and offline.
 */
/**
 * Extract the distinct salient entities from a piece of text. Returned keys are
 * normalised (lowercased, whitespace-collapsed) so they match glossary lookups.
 */
export declare function extractEntities(text: string): string[];
//# sourceMappingURL=entities.d.ts.map