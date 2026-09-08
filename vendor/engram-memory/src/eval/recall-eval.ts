/**
 * Recall evaluation + weight tuning (Phase 4).
 *
 * "Is recall actually good?" stops being a vibe and becomes a number. Given a
 * labelled set — queries paired with the ids that *should* surface — we measure
 * recall@k, MRR, and hit@1, and we can grid-search the fusion weights to
 * maximise them. This is the feedback loop that lets the scoring shape
 * (semantic / lexical / importance / recency / activation) be tuned against
 * real data instead of guessed.
 */

import type { Engram } from "../engram.js";
import type { RecallOptions, RecallWeights } from "../types.js";

export interface LabeledQuery {
  query: string;
  /** Ids that should be retrieved for this query. */
  relevantIds: string[];
}

export interface EvalMetrics {
  k: number;
  queries: number;
  /** Mean fraction of a query's relevant ids found in the top-k. */
  recallAtK: number;
  /** Mean reciprocal rank of the first relevant hit. */
  mrr: number;
  /** Fraction of queries whose #1 result is relevant. */
  hitAt1: number;
  perQuery: Array<{ query: string; recall: number; firstRelevantRank: number | null }>;
}

/** Score a set of labelled queries against the engine's current configuration. */
export async function evaluate(
  engram: Engram,
  set: LabeledQuery[],
  opts: { k?: number; recall?: Partial<RecallOptions> } = {},
): Promise<EvalMetrics> {
  const k = opts.k ?? 8;
  const perQuery: EvalMetrics["perQuery"] = [];
  let recallSum = 0, mrrSum = 0, hit1 = 0;

  for (const { query, relevantIds } of set) {
    const want = new Set(relevantIds);
    const hits = await engram.recall(query, { ...opts.recall, k });
    const ids = hits.map((h) => h.id);

    const found = ids.filter((id) => want.has(id)).length;
    const recall = want.size ? found / want.size : 0;
    recallSum += recall;

    let firstRank: number | null = null;
    for (let i = 0; i < ids.length; i++) if (want.has(ids[i]!)) { firstRank = i + 1; break; }
    if (firstRank) mrrSum += 1 / firstRank;
    if (firstRank === 1) hit1++;

    perQuery.push({ query, recall, firstRelevantRank: firstRank });
  }

  const n = set.length || 1;
  return { k, queries: set.length, recallAtK: recallSum / n, mrr: mrrSum / n, hitAt1: hit1 / n, perQuery };
}

export interface TuneResult {
  best: Partial<RecallWeights>;
  bestScore: number;
  baseline: number;
  trials: Array<{ weights: Partial<RecallWeights>; score: number }>;
}

/**
 * Grid-search a few fusion-weight combinations and keep the one with the best
 * recall@k on the labelled set. `grid` maps a weight name to the values to try;
 * the cartesian product is evaluated. Optimises recall@k (ties broken by MRR).
 */
export async function tuneWeights(
  engram: Engram,
  set: LabeledQuery[],
  grid: Partial<Record<keyof RecallWeights, number[]>>,
  opts: { k?: number; recall?: Partial<RecallOptions> } = {},
): Promise<TuneResult> {
  const k = opts.k ?? 8;
  const keys = Object.keys(grid) as Array<keyof RecallWeights>;

  // Cartesian product of the grid.
  let combos: Array<Partial<RecallWeights>> = [{}];
  for (const key of keys) {
    const vals = grid[key] ?? [];
    const next: Array<Partial<RecallWeights>> = [];
    for (const c of combos) for (const v of vals) next.push({ ...c, [key]: v });
    combos = next;
  }

  const baseline = (await evaluate(engram, set, opts)).recallAtK;
  const trials: TuneResult["trials"] = [];
  let best: Partial<RecallWeights> = {};
  let bestScore = -1, bestMrr = -1;

  for (const weights of combos) {
    const m = await evaluate(engram, set, { k, recall: { ...opts.recall, weights } });
    trials.push({ weights, score: m.recallAtK });
    if (m.recallAtK > bestScore || (m.recallAtK === bestScore && m.mrr > bestMrr)) {
      bestScore = m.recallAtK; bestMrr = m.mrr; best = weights;
    }
  }
  return { best, bestScore, baseline, trials };
}
