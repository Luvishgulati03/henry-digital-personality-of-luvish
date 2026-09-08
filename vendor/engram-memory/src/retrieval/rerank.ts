import type { LLMProvider } from "../llm/provider.js";
import type { RecallResult } from "../types.js";

/** Extract the first JSON array of 1-based indices from an LLM response. */
export function parseOrder(resp: string, n: number): number[] {
  const m = resp.match(/\[[\s\d,]*\]/);
  if (!m) return [];
  try {
    const arr = JSON.parse(m[0]) as unknown;
    if (!Array.isArray(arr)) return [];
    return arr.filter((x): x is number => Number.isInteger(x) && x >= 1 && x <= n);
  } catch {
    return [];
  }
}

const MAX_SNIPPET = 400;

/**
 * Rerank hybrid candidates with an LLM (your subscription CLI).
 *
 * The hybrid channels are cheap but imperfect; an LLM reading the actual text
 * judges relevance far better. We send the candidate snippets, ask for a JSON
 * array of indices most-relevant-first, and reorder. On any failure (timeout,
 * unparseable output) we fall back to the original hybrid order — reranking
 * never makes recall worse, only better.
 */
export async function llmRerank(
  llm: LLMProvider,
  query: string,
  candidates: RecallResult[],
  k: number,
): Promise<RecallResult[]> {
  if (candidates.length === 0) return [];
  if (candidates.length === 1) return candidates.slice(0, k);

  const list = candidates
    .map((c, i) => `[${i + 1}] ${c.content.replace(/\s+/g, " ").slice(0, MAX_SNIPPET)}`)
    .join("\n");
  const prompt =
    `You are selecting the memories most relevant to a query.\n\n` +
    `Query: "${query}"\n\nMemories:\n${list}\n\n` +
    `Return ONLY a JSON array of the memory numbers, most relevant first, ` +
    `including only genuinely relevant ones (at most ${k}). ` +
    `Example: [3,1,7]. Output nothing else.`;

  let resp: string;
  try {
    resp = await llm.complete(prompt);
  } catch {
    return candidates.slice(0, k); // graceful fallback
  }

  const order = parseOrder(resp, candidates.length);
  if (order.length === 0) return candidates.slice(0, k);

  const seen = new Set<number>();
  const ranked: RecallResult[] = [];
  for (const num of order) {
    const idx = num - 1;
    const cand = candidates[idx];
    if (cand && !seen.has(idx)) {
      seen.add(idx);
      ranked.push({ ...cand, why: `LLM-reranked · ${cand.why}` });
    }
  }
  // top up from the hybrid order if the LLM returned fewer than k
  for (let i = 0; i < candidates.length && ranked.length < k; i++) {
    if (!seen.has(i)) ranked.push(candidates[i]!);
  }
  return ranked.slice(0, k);
}
