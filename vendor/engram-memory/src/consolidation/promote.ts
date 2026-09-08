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

import type { MemoryRecord, MemoryStore, Tier } from "../store/types.js";

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

export const DEFAULT_PROMOTION: PromotionWeights = {
  frequency: 1,
  importance: 1,
  maturity: 0.5,
  maturityHalfLifeDays: 7,
};

/**
 * Promotion-worthiness of a memory: a blend of recall frequency (saturating),
 * intrinsic importance, and maturity. Higher = more deserving of long-term
 * status. The gate (minUseCount) is applied by `promote()`, not here.
 */
export function promotionScore(
  rec: { createdAt: number; useCount: number; importance: number },
  now: number,
  w: PromotionWeights = DEFAULT_PROMOTION,
): number {
  const frequency = 1 - 1 / (1 + rec.useCount); // 0 → 1, saturating
  const ageDays = Math.max(0, (now - rec.createdAt) / 86_400_000);
  const maturity = 1 - Math.pow(2, -ageDays / w.maturityHalfLifeDays); // 0 → 1 as it ages
  return w.frequency * frequency + w.importance * rec.importance + w.maturity * maturity;
}

export interface PromotionCandidate {
  id: string;
  /** Promotion score (higher = stronger case for long-term). */
  score: number;
  useCount: number;
  importance: number;
  fromTier: string | null;
  /** A short label (first ~100 chars of content) for human-readable output. */
  label: string;
  components: { frequency: number; importance: number; maturity: number };
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
export function promote(store: MemoryStore, opts: PromoteOptions = {}): PromoteResult {
  const now = opts.now ?? Date.now();
  const w = { ...DEFAULT_PROMOTION, ...(opts.weights ?? {}) };
  const fromTiers = new Set(opts.fromTiers ?? ["episodic"]);
  const toTier: Tier = opts.toTier ?? "semantic";
  const minUseCount = opts.minUseCount ?? 3;
  const minScore = opts.minScore ?? 0;
  const limit = opts.limit ?? Infinity;

  const transient = store.allRecords().filter((r) => !r.archived && fromTiers.has(r.tier ?? ""));

  const eligible = transient.filter((r) => r.useCount >= minUseCount);
  const candidates: PromotionCandidate[] = eligible
    .map((r) => {
      const score = promotionScore(r, now, w);
      const frequency = 1 - 1 / (1 + r.useCount);
      const maturity = 1 - Math.pow(2, -Math.max(0, (now - r.createdAt) / 86_400_000) / w.maturityHalfLifeDays);
      return {
        id: r.id,
        score,
        useCount: r.useCount,
        importance: r.importance,
        fromTier: r.tier,
        label: r.content.replace(/\s+/g, " ").trim().slice(0, 100),
        components: { frequency, importance: r.importance, maturity },
      };
    })
    .sort((a, b) => b.score - a.score);

  const result: PromoteResult = {
    scanned: transient.length,
    eligible: candidates.length,
    promoted: 0,
    candidates,
    promotedIds: [],
  };

  if (opts.dryRun) return result;

  const toPromote = candidates.filter((c) => c.score >= minScore).slice(0, limit === Infinity ? undefined : limit);
  for (const c of toPromote) {
    const rec = store.getById(c.id);
    if (!rec) continue;
    const metadata: Record<string, unknown> = {
      ...(rec.metadata ?? {}),
      promotedAt: now,
      promotedFrom: rec.tier,
    };
    const updated: MemoryRecord = { ...rec, tier: toTier, metadata, updatedAt: now };
    store.upsert(updated);
    result.promotedIds.push(c.id);
  }
  result.promoted = result.promotedIds.length;
  return result;
}
