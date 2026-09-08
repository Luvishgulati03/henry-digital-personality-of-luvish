import type { EmbeddingConfig } from "./embeddings/provider.js";
import type { LLMConfig } from "./llm/provider.js";
import type { RecallWeights } from "./types.js";
/**
 * Shape of an optional `engram.config.json` so users configure their setup once
 * (which embedder, which subscription LLM + model, default reranking) instead of
 * passing flags every time.
 */
export interface EngramFileConfig {
    dbPath?: string;
    embedding?: EmbeddingConfig;
    llm?: LLMConfig;
    defaultK?: number;
    weights?: Partial<RecallWeights>;
    /** Default for whether `recall` reranks with the LLM. */
    rerank?: boolean;
}
/**
 * Load config from an explicit path, or `engram.config.json` in the CWD if
 * present. Returns `{}` when there is no config (never throws on absence).
 */
export declare function loadConfig(path?: string): EngramFileConfig;
//# sourceMappingURL=config.d.ts.map