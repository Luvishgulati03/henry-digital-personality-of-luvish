/**
 * Promotion — the upward half of consolidation (short-term → long-term).
 *
 * `consolidate()` only forgets downward: it cold-archives low-salience memories
 * so the hot set stays sharp. But a memory system also needs the opposite move —
 * lifting a transient episodic memory that has *proven itself* into durable,
 * protected long-term storage. That is promotion.
 *
 * A memory earns long-term status the way a useful fact does in a brain: by
 * being recalled, repeatedly, across situations. engram already tracks that
 * signal — `useCount`/`lastUsedAt` are bumped whenever recall runs with
 * `markUsed` — so promotion needs no new bookkeeping. The model:
 *
 *   - GATE: only memories in a transient tier (default `episodic`) that have
 *     been recalled at least `minUseCount` times are even eligible. Recall is
 *     the evidence; one recall is noise, several is a pattern.
 *   - RANK: eligible memories are scored on a blend of recall frequency,
 *     intrinsic importance, and maturity (has it been around long enough to have
 *     had the chance to prove itself), then promoted highest-first up to `limit`.
 *   - PROMOTE: the memory's tier flips to a durable one (default `semantic`),
 *     which `consolidate()` treats as a protected tier — so once promoted, a
 *     memory is exempt from forgetting. Provenance (when, from which tier) is
 *     stamped into its metadata.
 *
 * Promotion is naturally idempotent: a promoted memory leaves the transient
 * tier, so it falls out of the candidate pool and is never re-promoted.
 *
 * No store-contract change: promotion is a read-modify-upsert over existing
 * methods, so it works on any `MemoryStore` backend. Pure and deterministic —
 * pass `now` to make it so in tests.
 */
import type { MemoryStore, Tier } from "../store/types.js";
export interface PromotionWeights {
    /** How much repeated recall counts toward durability. */
    frequency: number;
    /** How much intrinsic importance counts. */
    importance: number;
    /** How much "has had time to prove itself" counts. */
    maturity: number;
    /** Half-life (days) for the maturity term — age past which a memory is "mature". */
    maturityHalfLifeDays: number;
}
export declare const DEFAULT_PROMOTION: PromotionWeights;
/**
 * Promotion-worthiness of a memory: a blend of recall frequency (saturating),
 * intrinsic importance, and maturity. Higher = more deserving of long-term
 * status. The gate (minUseCount) is applied by `promote()`, not here.
 */
export declare function promotionScore(rec: {
    createdAt: number;
    useCount: number;
    importance: number;
}, now: number, w?: PromotionWeights): number;
export interface PromotionCandidate {
    id: string;
    /** Promotion score (higher = stronger case for long-term). */
    score: number;
    useCount: number;
    importance: number;
    fromTier: string | null;
    /** A short label (first ~100 chars of content) for human-readable output. */
    label: string;
    components: {
        frequency: number;
        importance: number;
        maturity: number;
    };
}
export interface PromoteOptions {
    /** Transient tiers eligible for promotion. Default ["episodic"]. */
    fromTiers?: string[];
    /** Durable tier promoted memories become (protected from consolidation). Default "semantic". */
    toTier?: Tier;
    /** Minimum recall count to be eligible — the "proven useful" gate. Default 3. */
    minUseCount?: number;
    /** Optional floor on promotion score; eligible memories below it aren't promoted. Default 0. */
    minScore?: number;
    /** Cap promotions per pass (highest-scoring first). Default Infinity. */
    limit?: number;
    weights?: Partial<PromotionWeights>;
    /** Rank candidates but make no changes. Default false (promotes). */
    dryRun?: boolean;
    now?: number;
}
export interface PromoteResult {
    /** Records in `fromTiers` that were scanned. */
    scanned: number;
    /** How many passed the minUseCount gate (the ranked candidate pool). */
    eligible: number;
    /** How many were actually promoted (0 when dryRun). */
    promoted: number;
    /** Eligible candidates, highest-scoring first (whether or not applied). */
    candidates: PromotionCandidate[];
    /** Ids promoted this pass. */
    promotedIds: string[];
}
/**
 * Run one promotion pass. Scan the transient tiers, keep memories recalled at
 * least `minUseCount` times, rank them, and (unless `dryRun`) flip the top ones
 * to the durable tier — stamping promotion provenance into metadata.
 */
export declare function promote(store: MemoryStore, opts?: PromoteOptions): PromoteResult;
//# sourceMappingURL=promote.d.ts.map