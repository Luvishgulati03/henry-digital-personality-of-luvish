/**
 * LLM-derived semantic edges — the relationships you can't get from vectors or
 * timestamps alone: `caused`, `supersedes`, `lesson_from`.
 *
 * The structural builders (`similar`, `temporal_next`, `about`) already tell us
 * which memories are *related*. This pass asks the LLM (the user's subscription
 * CLI — no API key) to read those related pairs and label the relationship's
 * KIND and DIRECTION. We only consider pairs that already share a structural
 * edge, so the LLM never sees an O(n²) explosion — just the graph's existing
 * neighbourhoods, in batches, capped.
 *
 * Failure is always safe: a timeout, an unparseable reply, or a thrown CLI
 * error simply yields fewer edges, never a crash and never a wrong edge.
 * Requires an LLM; a no-LLM caller gets an empty result.
 */

import type { EdgeType, MemoryEdge, MemoryStore } from "../store/types.js";
import type { LLMProvider } from "../llm/provider.js";
import { extractJsonArray } from "../util/json.js";

export interface LlmEdgeOptions {
  /** Max candidate pairs to classify (caps LLM cost). Default 80. */
  maxPairs?: number;
  /** Pairs per LLM call. Default 8. */
  batchSize?: number;
  /** Chars of each memory shown to the LLM. Default 280. */
  snippetChars?: number;
  /** Weight for created edges. Default 0.85. */
  weight?: number;
  /** Which structural edge types seed the candidate pairs. Default similar + temporal_next. */
  candidateTypes?: EdgeType[];
}

export interface LlmEdgeResult {
  caused: number;
  supersedes: number;
  lesson_from: number;
  pairsConsidered: number;
  calls: number;
}

const SEMANTIC_TYPES = new Set(["caused", "supersedes", "lesson_from"]);

interface Labelled {
  pair: number;
  rel: string;
  dir?: string; // "XY" (x→y) or "YX"
}

/** Extract the first JSON array of {pair,rel,dir} objects from an LLM reply. */
export function parseRelations(resp: string): Labelled[] {
  const arr = extractJsonArray(resp);
  if (!arr) return [];
  return arr
    .filter((o): o is Record<string, unknown> => !!o && typeof o === "object")
    .map((o) => ({ pair: Number(o.pair), rel: String(o.rel ?? "none"), dir: o.dir ? String(o.dir) : undefined }))
    .filter((o) => Number.isInteger(o.pair));
}

/** Collect unique unordered candidate pairs from the graph's structural edges. */
function candidatePairs(store: MemoryStore, types: EdgeType[], cap: number): Array<[string, string]> {
  const want = new Set(types);
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const e of store.allEdges()) {
    if (!want.has(e.type)) continue;
    if (e.srcId === e.dstId) continue;
    const key = e.srcId < e.dstId ? `${e.srcId}|${e.dstId}` : `${e.dstId}|${e.srcId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push([e.srcId, e.dstId]);
    if (out.length >= cap) break;
  }
  return out;
}

function buildPrompt(batch: Array<{ x: string; y: string }>, snippet: number): string {
  const lines = batch
    .map((p, i) => `[${i + 1}] X: "${p.x.replace(/\s+/g, " ").slice(0, snippet)}"  ||  Y: "${p.y.replace(/\s+/g, " ").slice(0, snippet)}"`)
    .join("\n");
  return (
    `You label the relationship between pairs of memories from an engineer's log.\n` +
    `For each numbered pair, output the strongest DIRECTED relationship, if any:\n` +
    `  - "caused": one describes an event/decision that led to the other\n` +
    `  - "supersedes": one corrects or replaces the other (the newer/authoritative one supersedes)\n` +
    `  - "lesson_from": one is a general lesson/rule distilled from the other concrete episode\n` +
    `  - "none": no strong directed relationship\n\n` +
    `Pairs:\n${lines}\n\n` +
    `Reply with ONLY a JSON array, one object per pair, e.g.\n` +
    `[{"pair":1,"rel":"caused","dir":"XY"},{"pair":2,"rel":"none"}]\n` +
    `"dir" is "XY" (X→Y) or "YX" (Y→X); omit it for "none". Output nothing else.`
  );
}

/**
 * Classify the graph's related pairs into semantic edges with an LLM.
 * Idempotent (edges upsert); safe to re-run.
 */
export async function buildLlmEdges(
  store: MemoryStore,
  llm: LLMProvider,
  opts: LlmEdgeOptions = {},
): Promise<LlmEdgeResult> {
  const maxPairs = opts.maxPairs ?? 80;
  const batchSize = opts.batchSize ?? 8;
  const snippet = opts.snippetChars ?? 280;
  const weight = opts.weight ?? 0.85;
  const types = opts.candidateTypes ?? ["similar", "temporal_next"];
  const result: LlmEdgeResult = { caused: 0, supersedes: 0, lesson_from: 0, pairsConsidered: 0, calls: 0 };

  const pairs = candidatePairs(store, types, maxPairs);
  result.pairsConsidered = pairs.length;
  if (pairs.length === 0) return result;

  const now = Date.now();
  const edges: MemoryEdge[] = [];
  const superseded = new Set<string>();

  for (let start = 0; start < pairs.length; start += batchSize) {
    const slice = pairs.slice(start, start + batchSize);
    const recs = store.getByIds(slice.flat());
    const byId = new Map(recs.map((r) => [r.id, r]));
    const batch = slice
      .map(([a, b]) => ({ a, b, ax: byId.get(a), bx: byId.get(b) }))
      .filter((p) => p.ax && p.bx)
      .map((p) => ({ a: p.a, b: p.b, x: p.ax!.content, y: p.bx!.content }));
    if (batch.length === 0) continue;

    let resp: string;
    try {
      resp = await llm.complete(buildPrompt(batch, snippet));
      result.calls++;
    } catch {
      continue; // a failed batch just yields no edges for that batch
    }

    for (const lab of parseRelations(resp)) {
      const item = batch[lab.pair - 1];
      if (!item || !SEMANTIC_TYPES.has(lab.rel)) continue;
      const [src, dst] = lab.dir === "YX" ? [item.b, item.a] : [item.a, item.b];
      edges.push({ srcId: src, dstId: dst, type: lab.rel, weight, createdAt: now, updatedAt: now });
      result[lab.rel as "caused" | "supersedes" | "lesson_from"]++;
      // Bi-temporal supersession: a `supersedes` edge means `src` (the newer,
      // authoritative memory) corrects `dst` — so `dst` is now stale. Stamp its
      // invalid_at so recall stops surfacing the corrected fact as current.
      if (lab.rel === "supersedes") superseded.add(dst);
    }
  }

  store.addEdges(edges);
  if (superseded.size > 0) store.setInvalidAt([...superseded], now);
  return result;
}
