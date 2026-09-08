import type { LLMProvider } from "../llm/provider.js";
import type { RecallResult } from "../types.js";
/** Extract the first JSON array of 1-based indices from an LLM response. */
export declare function parseOrder(resp: string, n: number): number[];
/**
 * Rerank hybrid candidates with an LLM (your subscription CLI).
 *
 * The hybrid channels are cheap but imperfect; an LLM reading the actual text
 * judges relevance far better. We send the candidate snippets, ask for a JSON
 * array of indices most-relevant-first, and reorder. On any failure (timeout,
 * unparseable output) we fall back to the original hybrid order — reranking
 * never makes recall worse, only better.
 */
export declare function llmRerank(llm: LLMProvider, query: string, candidates: RecallResult[], k: number): Promise<RecallResult[]>;
//# sourceMappingURL=rerank.d.ts.map