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
    perQuery: Array<{
        query: string;
        recall: number;
        firstRelevantRank: number | null;
    }>;
}
/** Score a set of labelled queries against the engine's current configuration. */
export declare function evaluate(engram: Engram, set: LabeledQuery[], opts?: {
    k?: number;
    recall?: Partial<RecallOptions>;
}): Promise<EvalMetrics>;
export interface TuneResult {
    best: Partial<RecallWeights>;
    bestScore: number;
    baseline: number;
    trials: Array<{
        weights: Partial<RecallWeights>;
        score: number;
    }>;
}
/**
 * Grid-search a few fusion-weight combinations and keep the one with the best
 * recall@k on the labelled set. `grid` maps a weight name to the values to try;
 * the cartesian product is evaluated. Optimises recall@k (ties broken by MRR).
 */
export declare function tuneWeights(engram: Engram, set: LabeledQuery[], grid: Partial<Record<keyof RecallWeights, number[]>>, opts?: {
    k?: number;
    recall?: Partial<RecallOptions>;
}): Promise<TuneResult>;
//# sourceMappingURL=recall-eval.d.ts.map