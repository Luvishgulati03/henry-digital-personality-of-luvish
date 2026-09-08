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
import { affectFromMetadata } from "../enrich/emotions.js";
export const DEFAULT_SALIENCE = {
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
export function salience(rec, now, w = DEFAULT_SALIENCE) {
    const ageDays = (now - (rec.lastUsedAt ?? rec.createdAt)) / 86_400_000;
    const recency = Math.pow(2, -Math.max(0, ageDays) / w.recencyHalfLifeDays); // 1 → 0
    const frequency = 1 - 1 / (1 + rec.useCount); // 0 → 1, saturating
    const emotion = affectFromMetadata(rec.metadata).intensity; // 0 when untagged
    return (w.recency * recency +
        w.frequency * frequency +
        w.importance * rec.importance +
        w.emotion * emotion);
}
/**
 * Run one consolidation pass: score the hot set and cold-archive the
 * lowest-salience memories beyond `capacity` (protected tiers exempt).
 */
export function consolidate(store, opts = {}) {
    const now = opts.now ?? Date.now();
    const w = { ...DEFAULT_SALIENCE, ...(opts.weights ?? {}) };
    const protect = new Set(opts.protectTiers ?? ["semantic", "procedural"]);
    const capacity = opts.capacity ?? Infinity;
    const hot = store.allRecords().filter((r) => !r.archived);
    const result = { scored: hot.length, archived: 0, kept: hot.length, protectedCount: 0, archivedIds: [] };
    if (!Number.isFinite(capacity) || hot.length <= capacity)
        return result;
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
export function readmit(store, ids) {
    store.setArchived(ids, false);
}
/**
 * Hebbian reinforcement: strengthen the edges among a set of co-used memories
 * (e.g. the results of one recall). Existing edges get their weight nudged up
 * toward 1; this is what makes frequently co-retrieved memories cluster over
 * time. Returns the number of edges reinforced.
 */
export function reinforce(store, ids, amount = 0.05) {
    const set = new Set(ids);
    if (set.size < 2)
        return 0;
    const now = Date.now();
    const seen = new Set();
    let n = 0;
    for (const e of store.edgesFrom([...set])) {
        if (!set.has(e.dstId))
            continue; // both endpoints in the co-used set
        const key = `${e.srcId}|${e.dstId}|${e.type}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        const weight = Math.min(1, e.weight + amount * (1 - e.weight));
        store.addEdge({ ...e, weight, updatedAt: now });
        n++;
    }
    return n;
}
//# sourceMappingURL=consolidate.js.map