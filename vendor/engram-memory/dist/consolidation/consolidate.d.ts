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
export declare const DEFAULT_SALIENCE: SalienceWeights;
/**
 * Salience of a memory: a blend of recency, retrieval frequency, importance,
 * and emotional intensity (read from metadata when present). Higher = keep hot.
 */
export declare function salience(rec: {
    createdAt: number;
    lastUsedAt: number | null;
    useCount: number;
    importance: number;
    metadata?: Record<string, unknown> | null;
}, now: number, w?: SalienceWeights): number;
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
export declare function consolidate(store: MemoryStore, opts?: ConsolidateOptions): ConsolidateResult;
/** Re-admit cold-archived memories (e.g. when one is hit again). */
export declare function readmit(store: MemoryStore, ids: string[]): void;
/**
 * Hebbian reinforcement: strengthen the edges among a set of co-used memories
 * (e.g. the results of one recall). Existing edges get their weight nudged up
 * toward 1; this is what makes frequently co-retrieved memories cluster over
 * time. Returns the number of edges reinforced.
 */
export declare function reinforce(store: MemoryStore, ids: string[], amount?: number): number;
//# sourceMappingURL=consolidate.d.ts.map