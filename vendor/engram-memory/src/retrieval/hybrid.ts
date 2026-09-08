import type { MemoryStore } from "../store/types.js";
import type { EmbeddingProvider } from "../embeddings/provider.js";
import type { RecallOptions, RecallResult, RecallWeights } from "../types.js";
import { cosine } from "../util/cosine.js";
import { affectFromMetadata } from "../enrich/emotions.js";

export const DEFAULT_WEIGHTS: RecallWeights = {
  semantic: 1,
  lexical: 1,
  importance: 0.5,
  // Recency on by default: fresh memories (e.g. just-captured conversations)
  // get a moderate lift so a thing you told the agent moments ago ranks above
  // stale matches. Gentle enough not to drown clear relevance.
  recency: 0.4,
  // Frequency + affect: gentle by default, like importance — they break ties and
  // tilt close calls (a memory you keep recalling, or one tagged high-arousal)
  // without overriding clear relevance.
  frequency: 0.3,
  emotion: 0.3,
  activation: 1,
  rrfK: 60,
  recencyHalfLifeDays: 30,
};

interface FuseEntry {
  rrf: number;
  semScore?: number;
  lexScore?: number;
  semRank?: number;
  lexRank?: number;
}

/**
 * Hybrid recall = two channels fused with Reciprocal Rank Fusion (RRF), then
 * nudged by salience (importance) and optionally recency.
 *
 *  1. SEMANTIC: cosine of the query embedding against every stored vector.
 *  2. LEXICAL:  FTS5/bm25 keyword match.
 *
 * RRF is used because the two channels produce incomparable raw scores (cosine
 * vs bm25); fusing by *rank* (score += w / (rrfK + rank)) is robust and needs
 * no score normalisation. Convergent evidence — a memory ranking high in both
 * channels — accumulates, which is exactly the behaviour we want.
 */
export async function recall(
  store: MemoryStore,
  provider: EmbeddingProvider,
  query: string,
  opts: RecallOptions,
  baseWeights: RecallWeights,
): Promise<RecallResult[]> {
  const w: RecallWeights = { ...baseWeights, ...(opts.weights ?? {}) };
  const k = opts.k ?? 8;
  const pool = opts.candidatePool ?? 50;
  const entries = new Map<string, FuseEntry>();

  // --- Channel 1: semantic (vector cosine) ---
  const qEmb = (await provider.embed([query]))[0];
  if (qEmb) {
    const ranked = store
      .allVectors()
      .filter((v) => v.dim === provider.dim)
      .map((v) => ({ id: v.id, score: cosine(qEmb, v.embedding) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, pool);
    ranked.forEach((hit, i) => {
      const e = entries.get(hit.id) ?? { rrf: 0 };
      e.rrf += w.semantic * (1 / (w.rrfK + i));
      e.semScore = hit.score;
      e.semRank = i + 1;
      entries.set(hit.id, e);
    });
  }

  // --- Channel 2: lexical (FTS5/bm25, already best-first) ---
  store.ftsSearch(query, pool).forEach((hit, i) => {
    const e = entries.get(hit.id) ?? { rrf: 0 };
    e.rrf += w.lexical * (1 / (w.rrfK + i));
    e.lexScore = hit.score;
    e.lexRank = i + 1;
    entries.set(hit.id, e);
  });

  if (entries.size === 0) return [];

  // --- Materialise candidates and apply salience / recency boosts ---
  let records = store.getByIds([...entries.keys()]);
  if (!opts.includeArchived) records = records.filter((r) => !r.archived);
  if (!opts.includeSuperseded) records = records.filter((r) => r.invalidAt == null);
  if (opts.tier) records = records.filter((r) => r.tier === opts.tier);

  const now = Date.now();
  const results: RecallResult[] = records.map((r) => {
    const e = entries.get(r.id)!;
    let score = e.rrf;

    // Salience nudge: importance 0.5 is neutral. Deliberately gentle so it
    // breaks ties and tilts close calls without overriding clear relevance.
    // With the default weight (0.5) the multiplier stays within ~[0.75, 1.25].
    const impBoost = 1 + w.importance * (r.importance - 0.5);
    score *= Math.max(0.1, impBoost);

    // Optional recency boost (off by default; Phase 2 makes this central).
    if (w.recency > 0) {
      const ageDays = (now - (r.lastUsedAt ?? r.createdAt)) / 86_400_000;
      const recencyTerm = Math.pow(2, -ageDays / w.recencyHalfLifeDays);
      score *= 1 + w.recency * recencyTerm;
    }

    // Frequency boost: often-recalled memories stay sharp (saturating in useCount).
    let freqTerm: number | undefined;
    if (w.frequency > 0 && r.useCount > 0) {
      freqTerm = 1 - 1 / (1 + r.useCount); // 0 → 1, saturating
      score *= 1 + w.frequency * freqTerm;
    }

    // Affect boost: high-arousal memories are better recalled (amygdala flag).
    const affect = affectFromMetadata(r.metadata);
    if (w.emotion > 0 && affect.intensity > 0) {
      score *= 1 + w.emotion * affect.intensity;
    }

    const why: string[] = [];
    if (e.semRank) why.push(`semantic #${e.semRank} (${(e.semScore ?? 0).toFixed(2)})`);
    if (e.lexRank) why.push(`lexical #${e.lexRank}`);
    why.push(`importance ${r.importance.toFixed(2)}`);
    if (freqTerm) why.push(`used ${r.useCount}×`);
    if (affect.intensity > 0) why.push(`${affect.emotion ?? "affect"} ${affect.intensity.toFixed(2)}`);

    return {
      id: r.id,
      content: r.content,
      source: r.source,
      tier: r.tier,
      importance: r.importance,
      score,
      scores: {
        semantic: e.semScore, lexical: e.lexScore, rrf: e.rrf,
        frequency: freqTerm, emotion: affect.intensity || undefined,
      },
      ranks: { semantic: e.semRank, lexical: e.lexRank },
      metadata: r.metadata,
      why: why.join(" · "),
    };
  });

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, k);

  if (opts.markUsed) store.markUsed(top.map((r) => r.id));
  return top;
}
