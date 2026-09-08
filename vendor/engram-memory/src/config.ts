import { existsSync, readFileSync } from "node:fs";
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

const DEFAULT_PATH = "engram.config.json";

/**
 * Load config from an explicit path, or `engram.config.json` in the CWD if
 * present. Returns `{}` when there is no config (never throws on absence).
 */
export function loadConfig(path?: string): EngramFileConfig {
  const file = path ?? (existsSync(DEFAULT_PATH) ? DEFAULT_PATH : null);
  if (!file) return {};
  try {
    return JSON.parse(readFileSync(file, "utf8")) as EngramFileConfig;
  } catch (e) {
    throw new Error(`Failed to read config ${file}: ${e instanceof Error ? e.message : String(e)}`);
  }
}
