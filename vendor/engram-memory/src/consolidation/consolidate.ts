/**
 * Consolidation — engram's "dreaming" layer (Phase 3).
 *
 * Memory can't grow without bound and stay sharp. Like a sleeping brain, engram
 * periodically replays the day, scores each memory's *salience*, and decides
 * what to keep hot and what to let fade. The model is value-based forgetting,
 * not LRU: a memory survives on a blend of recency, how often it's been
 * retrieved, and its importance — so an old-but-important lesson outlives a
 * fresh-but-trivial note.
 *
 * Forgetting here is reversible: low-salience memories are *cold-archived*
 * (excluded from recall), never hard-deleted, and re-admitted the moment
 * they're hit again. Protected tiers (semantic/procedural lessons) are never
 * archived. A dream pass also strengthens the edges between memories that were
 * recently used together (Hebbian: cells that fire together, wire together).
 */

import type { MemoryStore } from "../store/types.js";
import { affectFromMetadata } from "../enrich/emotions.js";

export interface SalienceWeights {
  recency: number;
  frequency: number;
  importance: number;
  /**
   * Weight on emotional intensity — an affect-laden memory (a prod outage, a
   * hard correction) resists forgetting the way the brain hangs onto
   * high-arousal events. 0 makes consolidation affect-blind.
   */
  emotion: number;
  /** Half-life (days) for the recency term. */
  recencyHalfLifeDays: number;
}

export const DEFAULT_SALIENCE: SalienceWeights = {
  recency: 1,
  frequency: 1,
  importance: 1.5,
  emotion: 0.75,
  recencyHalfLifeDays: 14,
};

/**
 * Salience of a memory: a blend of recency, retrieval frequency, importance,
 * and emotional intensity (read from metadata when present). Higher = keep hot.
 */
export function salience(
  rec: {
    createdAt: number; lastUsedAt: number | null; useCount: number; importance: number;
    metadata?: Record<string, unknown> | null;
  },
  now: number,
  w: SalienceWeights = DEFAULT_SALIENCE,
): number {
  const ageDays = (now - (rec.lastUsedAt ?? rec.createdAt)) / 86_400_000;
  const recency = Math.pow(2, -Math.max(0, ageDays) / w.recencyHalfLifeDays); // 1 → 0
  const frequency = 1 - 1 / (1 + rec.useCount); // 0 → 1, saturating
  const emotion = affectFromMetadata(rec.metadata).intensity; // 0 when untagged
  return (
    w.recency * recency +
    w.frequency * frequency +
    w.importance * rec.importance +
    w.emotion * emotion
  );
}

export interface ConsolidateOptions {
  /** Max hot (non-archived) memories to keep. Beyond this, the lowest-salience are archived. */
  capacity?: number;
  /** Tiers that are never archived (long-term lessons). Default semantic + procedural. */
  protectTiers?: string[];
  weights?: Partial<SalienceWeights>;
  now?: number;
}

export interface ConsolidateResult {
  scored: number;
  archived: number;
  kept: number;
  protectedCount: number;
  /** The ids archived this pass (for the dashboard to animate the fade-out). */
  archivedIds: string[];
}

/**
 * Run one consolidation pass: score the hot set and cold-archive the
 * lowest-salience memories beyond `capacity` (protected tiers exempt).
 */
export function consolidate(store: MemoryStore, opts: ConsolidateOptions = {}): ConsolidateResult {
  const now = opts.now ?? Date.now();
  const w = { ...DEFAULT_SALIENCE, ...(opts.weights ?? {}) };
  const protect = new Set(opts.protectTiers ?? ["semantic", "procedural"]);
  const capacity = opts.capacity ?? Infinity;

  const hot = store.allRecords().filter((r) => !r.archived);
  const result: ConsolidateResult = { scored: hot.length, archived: 0, kept: hot.length, protectedCount: 0, archivedIds: [] };
  if (!Number.isFinite(capacity) || hot.length <= capacity) return result;

  const evictable = hot.filter((r) => !protect.has(r.tier ?? ""));
  result.protectedCount = hot.length - evictable.length;

  // Lowest salience first — those are the ones to let fade.
  evictable.sort((a, b) => salience(a, now, w) - salience(b, now, w));
  const overflow = hot.length - capacity;
  const toArchive = evictable.slice(0, Math.min(overflow, evictable.length));

  if (toArchive.length) {
    const ids = toArchive.map((r) => r.id);
    store.setArchived(ids, true);
    result.archived = ids.length;
    result.archivedIds = ids;
    result.kept = hot.length - ids.length;
  }
  return result;
}

/** Re-admit cold-archived memories (e.g. when one is hit again). */
export function readmit(store: MemoryStore, ids: string[]): void {
  store.setArchived(ids, false);
}

/**
 * Hebbian reinforcement: strengthen the edges among a set of co-used memories
 * (e.g. the results of one recall). Existing edges get their weight nudged up
 * toward 1; this is what makes frequently co-retrieved memories cluster over
 * time. Returns the number of edges reinforced.
 */
export function reinforce(store: MemoryStore, ids: string[], amount = 0.05): number {
  const set = new Set(ids);
  if (set.size < 2) return 0;
  const now = Date.now();
  const seen = new Set<string>();
  let n = 0;
  for (const e of store.edgesFrom([...set])) {
    if (!set.has(e.dstId)) continue; // both endpoints in the co-used set
    const key = `${e.srcId}|${e.dstId}|${e.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const weight = Math.min(1, e.weight + amount * (1 - e.weight));
    store.addEdge({ ...e, weight, updatedAt: now });
    n++;
  }
  return n;
}
