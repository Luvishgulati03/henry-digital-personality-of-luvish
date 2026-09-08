import { SqliteStore } from "./store/sqlite-store.js";
import { createEmbeddingProvider } from "./embeddings/provider.js";
import { createLLMProvider } from "./llm/provider.js";
import { ingestDirectory } from "./ingest/markdown.js";
import { buildEdges } from "./graph/build.js";
import { buildLlmEdges } from "./graph/llm-edges.js";
import { extractEntities } from "./graph/entities.js";
import { tagMemories as tagMemoriesImpl } from "./enrich/tagging.js";
import { affectFromMetadata } from "./enrich/emotions.js";
import { consolidate, reinforce, readmit, salience, DEFAULT_SALIENCE, } from "./consolidation/consolidate.js";
import { promote } from "./consolidation/promote.js";
import { recall as hybridRecall, DEFAULT_WEIGHTS } from "./retrieval/hybrid.js";
import { cosine } from "./util/cosine.js";
import { spreadActivation } from "./retrieval/spreading.js";
import { llmRerank } from "./retrieval/rerank.js";
import { sha256 } from "./util/hash.js";
/**
 * Base activation given to a memory matched by query-entity seeding — roughly
 * the level of a solid single-channel hybrid hit, so entity matches enter the
 * results meaningfully without swamping clear lexical/semantic relevance.
 */
const ENTITY_SEED = 0.02;
/**
 * Skip query-entity seeding for entities tagged on more than this many
 * memories — mirrors the `about`-edge doc-frequency cap in graph/build.ts.
 */
const ENTITY_SEED_MAX_DF = 8;
/** Accepts 0..1 directly, or a 1..10 salience scale (auto-divided by 10). */
function normalizeImportance(v) {
    if (v === undefined || Number.isNaN(v))
        return 0.5;
    const x = v > 1 ? v / 10 : v;
    return Math.min(1, Math.max(0, x));
}
/**
 * Engram — the public memory engine.
 *
 * One object wires a storage backend + an embedding provider + ingestion +
 * hybrid retrieval. The markdown files (or any text you `add`) remain the
 * source of truth; the SQLite index is a derived, rebuildable cache.
 *
 * @example
 * const mem = new Engram({ dbPath: "agent.db" });
 * await mem.indexDirectory("./memories");
 * const hits = await mem.recall("what went wrong last deploy?", { k: 5 });
 * const context = mem.toContextBlock(hits); // inject into your prompt
 */
export class Engram {
    store;
    embedding;
    /** The configured LLM (subscription CLI), or null for pure hybrid search. */
    llm;
    defaultK;
    weights;
    constructor(opts = {}) {
        this.store = new SqliteStore(opts.dbPath ?? "engram.db");
        this.embedding = createEmbeddingProvider(opts.embedding);
        this.llm = createLLMProvider(opts.llm);
        this.defaultK = opts.defaultK ?? 8;
        this.weights = { ...DEFAULT_WEIGHTS, ...(opts.weights ?? {}) };
    }
    /** Store one memory. Returns its id (stable hash of content if not provided). */
    async add(input) {
        const recs = await this.toRecords([input]);
        const rec = recs[0];
        this.store.upsert(rec);
        return rec.id;
    }
    /** Store many memories in a single transaction. */
    async addMany(inputs) {
        if (inputs.length === 0)
            return [];
        const recs = await this.toRecords(inputs);
        this.store.upsertMany(recs);
        return recs.map((r) => r.id);
    }
    async toRecords(inputs) {
        const now = Date.now();
        const embeddings = await this.embedding.embed(inputs.map((i) => i.content));
        return inputs.map((input, idx) => {
            const emb = embeddings[idx] ?? null;
            return {
                id: input.id ?? sha256(input.content).slice(0, 16),
                content: input.content,
                source: input.source ?? null,
                tier: input.tier ?? null,
                importance: normalizeImportance(input.importance),
                metadata: input.metadata ?? null,
                contentHash: sha256(input.content),
                createdAt: input.createdAt ?? now,
                updatedAt: now,
                lastUsedAt: null,
                useCount: 0,
                archived: false,
                validAt: input.createdAt ?? now,
                invalidAt: null,
                embedding: emb,
                embeddingModel: this.embedding.name,
                embeddingDim: emb ? emb.length : null,
            };
        });
    }
    /**
     * Index a directory of markdown/text files into memories. Non-destructive to
     * the files themselves — the DB is a derived cache that can be rebuilt anytime.
     */
    async indexDirectory(dir, opts = {}) {
        const start = Date.now();
        if (opts.fresh)
            this.store.clear();
        let inputs = ingestDirectory(dir, opts);
        const sources = new Set(inputs.map((i) => i.source).filter((s) => !!s));
        let pruned = 0;
        // Incremental: skip content already stored AND unchanged (compared by
        // content hash, since directory-ingest ids are position-based). Only
        // new/edited chunks get embedded — critical when embedding costs
        // money/latency (e.g. OpenAI), and what makes append-style auto-capture
        // cheap. Edge derivation is likewise restricted to the changed ids.
        // Mutually exclusive with fresh/prune.
        if (opts.incremental && !opts.fresh) {
            const before = inputs.length;
            inputs = inputs.filter((i) => {
                const id = i.id ?? sha256(i.content).slice(0, 16);
                const existing = this.store.getById(id);
                // Keep chunks that are new OR whose content changed (edited in place) —
                // otherwise an edited paragraph keeps serving its outdated text until
                // the next full reindex.
                return !existing || existing.contentHash !== sha256(i.content);
            });
            const addedIds = await this.addManyResult(inputs);
            if (opts.edges !== false && addedIds.length > 0) {
                this.buildEdges({
                    ...(typeof opts.edges === "object" ? opts.edges : {}),
                    onlyIds: addedIds,
                });
            }
            return {
                directory: dir, files: sources.size, memories: addedIds.length,
                pruned: 0, skipped: before - addedIds.length,
                durationMs: Date.now() - start,
                embeddingModel: this.embedding.name,
            };
        }
        if (opts.prune !== false && !opts.fresh) {
            for (const src of sources)
                pruned += this.store.deleteBySourcePrefix(src);
        }
        await this.addMany(inputs);
        if (opts.edges !== false) {
            this.buildEdges(typeof opts.edges === "object" ? opts.edges : undefined);
        }
        return {
            directory: dir,
            files: sources.size,
            memories: inputs.length,
            pruned,
            skipped: 0,
            durationMs: Date.now() - start,
            embeddingModel: this.embedding.name,
        };
    }
    /** addMany that returns the stored ids (for incremental edge derivation). */
    async addManyResult(inputs) {
        if (inputs.length === 0)
            return [];
        const recs = await this.toRecords(inputs);
        this.store.upsertMany(recs);
        return recs.map((r) => r.id);
    }
    /**
     * (Re)derive the associative graph over every stored memory — `similar`
     * (embedding kNN) and `temporal_next` (per-source chronology) edges. Cheap,
     * deterministic, offline. Called automatically by `indexDirectory`; expose
     * it for callers who `add()` memories directly and want to refresh the graph.
     */
    buildEdges(opts) {
        return buildEdges(this.store, opts ?? {});
    }
    /**
     * Derive semantic edges (`caused`, `supersedes`, `lesson_from`) by having the
     * configured LLM classify the graph's already-related pairs. Returns a count
     * of each kind. No-op (zeros) when no LLM is configured. Run after
     * `buildEdges`/`indexDirectory`, since it seeds from the structural edges.
     */
    async buildLlmEdges(opts) {
        if (!this.llm)
            return { caused: 0, supersedes: 0, lesson_from: 0, pairsConsidered: 0, calls: 0 };
        return buildLlmEdges(this.store, this.llm, opts ?? {});
    }
    /**
     * Run a consolidation ("dream") pass: cold-archive the lowest-salience
     * memories beyond `capacity` (value-based forgetting; protected tiers exempt).
     * Archived memories drop out of recall but are kept and re-admittable.
     */
    consolidate(opts) {
        return consolidate(this.store, opts ?? {});
    }
    /** Re-admit cold-archived memories back into recall. */
    readmit(ids) {
        readmit(this.store, ids);
    }
    /**
     * Mark a memory superseded by a newer one (bi-temporal correction). Stamps the
     * older memory's `invalidAt` so recall stops surfacing it as current, and
     * records a `supersedes` edge from the newer memory to the older for the audit
     * trail. Pass `at` to control the timestamp (defaults to now). Idempotent.
     * Use `recall(q, { includeSuperseded: true })` to see superseded facts again.
     */
    supersede(newerId, olderId, at) {
        const now = at ?? Date.now();
        this.store.setInvalidAt([olderId], now);
        this.store.addEdge({
            srcId: newerId, dstId: olderId, type: "supersedes", weight: 1, createdAt: now, updatedAt: now,
        });
    }
    /**
     * Promote proven memories from short-term to long-term: transient (episodic)
     * memories recalled at least `minUseCount` times are flipped to a durable tier
     * (default `semantic`), which `consolidate()` then protects from forgetting.
     * The upward counterpart to `consolidate()`'s downward archiving. Pass
     * `{ dryRun: true }` to rank candidates without changing anything.
     */
    promote(opts) {
        return promote(this.store, opts ?? {});
    }
    /**
     * One-call nightly maintenance — the whole short-term/long-term cycle. Runs
     * promotion first (so memories that earned long-term status become protected),
     * then consolidation (archive the low-salience remainder). Both passes share a
     * single clock so their recency maths agree.
     *
     * Plug-and-play default: promotion runs; consolidation only archives if you
     * give it a `capacity` (otherwise it's a safe no-op). Pass `false` for either
     * sub-pass to skip it. Schedule this on a cron and forget about it.
     *
     * @example mem.dream({ consolidate: { capacity: 5000 } }); // promote + cap at 5k
     */
    dream(opts = {}) {
        const now = Date.now();
        const promotion = opts.promote === false ? null : promote(this.store, { now, ...(opts.promote ?? {}) });
        const consolidation = opts.consolidate === false ? null : consolidate(this.store, { now, ...(opts.consolidate ?? {}) });
        return { promotion, consolidation };
    }
    /**
     * Tag memory texts with structure + emotion + importance + people + topic
     * using the configured LLM (heuristic neutral/episodic fallback without one).
     * Returns one tag set per input, in order. Used to enrich captured memories.
     */
    async tagMemories(texts) {
        return tagMemoriesImpl(this.llm, texts);
    }
    /**
     * Hebbian reinforcement: strengthen edges among a co-used set of memories
     * (e.g. the ids returned by one recall). Returns edges reinforced.
     */
    reinforce(ids, amount) {
        return reinforce(this.store, ids, amount);
    }
    /**
     * Recall the top-k most relevant memories for a query (hybrid search).
     * With `{ rerank: true }` and an LLM configured, hybrid produces a larger
     * candidate pool that the LLM (your subscription) then reorders by reading the
     * actual text — higher quality, at the cost of one LLM call.
     */
    async recall(query, opts = {}) {
        const k = opts.k ?? this.defaultK;
        const doRerank = Boolean(opts.rerank) && this.llm !== null;
        // Hebbian: optionally strengthen edges among the co-retrieved results.
        const fin = (out) => {
            if (opts.reinforce && out.length > 1)
                this.reinforce(out.map((r) => r.id));
            return out;
        };
        if (opts.associative) {
            const { results: ranked } = await this.associativeRecall(query, opts);
            // Rerank composes on top of associative recall when an LLM is configured.
            if (doRerank) {
                const out = await llmRerank(this.llm, query, ranked, k);
                if (opts.markUsed)
                    this.store.markUsed(out.map((r) => r.id));
                return fin(out);
            }
            if (opts.markUsed)
                this.store.markUsed(ranked.slice(0, k).map((r) => r.id));
            return fin(ranked.slice(0, k));
        }
        if (!doRerank) {
            return fin(await hybridRecall(this.store, this.embedding, query, { k, ...opts }, this.weights));
        }
        const pool = opts.rerankPool ?? Math.max(k * 4, 20);
        const candidates = await hybridRecall(this.store, this.embedding, query, { ...opts, k: pool, markUsed: false }, this.weights);
        const ranked = await llmRerank(this.llm, query, candidates, k);
        if (opts.markUsed)
            this.store.markUsed(ranked.map((r) => r.id));
        return fin(ranked);
    }
    /**
     * Bayesian-surprise-style novelty of a piece of text: 1 − its maximum cosine
     * similarity to anything already stored (1 = wholly novel, 0 = a duplicate).
     * A cheap, offline importance signal — surprising memories tend to matter.
     * Returns 1 for an empty store (everything is novel at first).
     */
    async surprise(content) {
        const [emb] = await this.embedding.embed([content]);
        if (!emb)
            return 0.5;
        let maxSim = 0;
        for (const v of this.store.allVectors()) {
            if (v.dim !== this.embedding.dim)
                continue;
            const s = cosine(emb, v.embedding);
            if (s > maxSim)
                maxSim = s;
        }
        return Math.max(0, Math.min(1, 1 - maxSim));
    }
    /**
     * Associative recall: hybrid hits seed activation that spreads across the
     * graph, then the two signals are fused. Hybrid hits keep their relevance and
     * gain a lift for inflowing activation; memories reached *only* by spreading
     * enter the results on activation alone — surfacing related context the flat
     * index would miss. Falls back to plain hybrid order when the graph is empty.
     */
    async associativeRecall(query, opts) {
        const w = { ...this.weights, ...(opts.weights ?? {}) };
        // Seed from a broad hybrid pool so activation starts from solid relevance.
        const pool = opts.candidatePool ?? 50;
        const seedsResults = await hybridRecall(this.store, this.embedding, query, { ...opts, k: pool, markUsed: false }, this.weights);
        const byId = new Map();
        for (const r of seedsResults)
            byId.set(r.id, r);
        const seeds = new Map(seedsResults.map((r) => [r.id, r.score]));
        const traceSeeds = seedsResults.map((r) => ({
            id: r.id,
            score: r.score,
            kind: "hybrid",
        }));
        // Query-entity seeding: memories tagged with an entity the query mentions
        // are precise, topic-level hits — seed them directly (and surface them) so
        // they participate even when hybrid relevance missed them entirely.
        if (opts.entitySeeding !== false) {
            const matched = new Map(); // memoryId → the matched entity
            for (const e of extractEntities(query)) {
                const ids = this.store.memoriesForEntity(e);
                // Doc-frequency cap (same rationale as about-edges): an entity tagged on
                // many memories ("API", "MCP") is too common to be a meaningful topic
                // hit — seeding all of them would flood the results with 0.02-score
                // matches that outrank mid-tier genuine hybrid hits.
                if (ids.length === 0 || ids.length > ENTITY_SEED_MAX_DF)
                    continue;
                for (const id of ids) {
                    if (!matched.has(id))
                        matched.set(id, e);
                }
            }
            const fresh = this.store.getByIds([...matched.keys()].filter((id) => !byId.has(id)));
            const freshById = new Map(fresh.map((r) => [r.id, r]));
            for (const [id, entity] of matched) {
                if (!seeds.has(id)) {
                    seeds.set(id, ENTITY_SEED);
                    traceSeeds.push({ id, score: ENTITY_SEED, kind: "entity", entity });
                }
                if (byId.has(id))
                    continue;
                const rec = freshById.get(id);
                if (!rec)
                    continue;
                if (!opts.includeArchived && rec.archived)
                    continue; // cold-archived
                if (!opts.includeSuperseded && rec.invalidAt != null)
                    continue; // stale fact
                byId.set(id, {
                    id: rec.id,
                    content: rec.content,
                    source: rec.source,
                    tier: rec.tier,
                    importance: rec.importance,
                    score: ENTITY_SEED,
                    scores: { rrf: 0 },
                    ranks: {},
                    metadata: rec.metadata,
                    why: `entity match: "${entity}"`,
                });
            }
        }
        const activated = spreadActivation(this.store, seeds, opts.spread);
        // Collect records for activation-only nodes (not already in the hybrid pool).
        const newIds = [...activated.keys()].filter((id) => !byId.has(id));
        const fresh = this.store.getByIds(newIds);
        const freshById = new Map(fresh.map((r) => [r.id, r]));
        const activations = [];
        for (const [id, act] of activated) {
            const lift = w.activation * act.activation;
            const trace = `activation ${act.activation.toFixed(3)} via ${act.via.type}←${act.via.from}`;
            const existing = byId.get(id);
            if (existing) {
                existing.score += lift;
                existing.scores.activation = act.activation;
                existing.why += ` · +${trace}`;
                activations.push({ id, activation: act.activation, via: act.via });
                continue;
            }
            const rec = freshById.get(id);
            if (!rec)
                continue; // dangling edge endpoint — skip
            if (!opts.includeArchived && rec.archived)
                continue; // cold-archived
            if (!opts.includeSuperseded && rec.invalidAt != null)
                continue; // stale fact
            byId.set(id, {
                id: rec.id,
                content: rec.content,
                source: rec.source,
                tier: rec.tier,
                importance: rec.importance,
                score: lift,
                scores: { rrf: 0, activation: act.activation },
                ranks: {},
                metadata: rec.metadata,
                why: `associative: ${trace}`,
            });
            activations.push({ id, activation: act.activation, via: act.via });
        }
        let results = [...byId.values()];
        if (opts.tier)
            results = results.filter((r) => r.tier === opts.tier);
        results.sort((a, b) => b.score - a.score);
        return { results, trace: { query, seeds: traceSeeds, activations } };
    }
    /**
     * Like `recall({ associative: true })`, but also returns the full activation
     * trace — the seed memories and how much each node was lit up, via which
     * edge. Powers the dashboard's neuron visualisation and any "why did this
     * surface" audit. Always runs in associative mode.
     */
    async recallTrace(query, opts = {}) {
        const k = opts.k ?? this.defaultK;
        const { results, trace } = await this.associativeRecall(query, { ...opts, associative: true });
        const top = results.slice(0, k);
        if (opts.markUsed)
            this.store.markUsed(top.map((r) => r.id));
        if (opts.reinforce && top.length > 1)
            this.reinforce(top.map((r) => r.id));
        return { results: top, trace };
    }
    /**
     * Export the whole associative graph (nodes + edges + stats) for
     * visualisation. Node content is truncated to a short label to keep the
     * payload light; fetch full content via `recall`/`store.getById` on demand.
     */
    graphExport(opts = {}) {
        const labelChars = opts.labelChars ?? 120;
        const now = Date.now();
        const nodes = this.store.allRecords().map((r) => {
            const md = (r.metadata ?? {});
            // Frontmatter `metadata:` is nested under record.metadata.metadata; fall
            // back to the top level for memories tagged a different way.
            const inner = (md.metadata && typeof md.metadata === "object" ? md.metadata : md);
            const affect = affectFromMetadata(r.metadata);
            return {
                id: r.id,
                label: r.content.replace(/\s+/g, " ").trim().slice(0, labelChars),
                tier: r.tier,
                importance: r.importance,
                source: r.source,
                useCount: r.useCount,
                archived: r.archived,
                salience: salience(r, now, DEFAULT_SALIENCE),
                emotion: affect.emotion,
                emotionIntensity: affect.intensity || undefined,
                topic: typeof inner.topic === "string" && inner.topic ? inner.topic : undefined,
            };
        });
        const edges = this.store.allEdges().map((e) => ({
            src: e.srcId,
            dst: e.dstId,
            type: e.type,
            weight: e.weight,
        }));
        return { nodes, edges, stats: this.store.stats() };
    }
    /**
     * Rate a memory's long-term importance (0..1) using the configured LLM.
     * Returns 0.5 (neutral) if no LLM is set or the call fails. Opt-in helper for
     * auto-scoring salience at write time.
     */
    async rateImportance(text) {
        if (!this.llm)
            return 0.5;
        const prompt = `Rate how important this memory is for an agent to remember long-term, ` +
            `on a scale of 1 (trivial) to 10 (critical). Consider consequence, ` +
            `surprise, and reusability. Reply with ONLY the number.\n\nMemory: ${text}`;
        try {
            const resp = await this.llm.complete(prompt);
            const m = resp.match(/\d+(\.\d+)?/);
            if (!m)
                return 0.5;
            const n = Number.parseFloat(m[0]);
            return Math.min(1, Math.max(0, n > 1 ? n / 10 : n));
        }
        catch {
            return 0.5;
        }
    }
    /** Format recall results as a prompt-ready context block for any agent. */
    toContextBlock(results, opts = {}) {
        if (results.length === 0)
            return "";
        const header = opts.header ?? "Relevant memories (most relevant first):";
        const withSource = opts.withSource ?? true;
        const lines = results.map((r, i) => {
            const src = withSource && r.source ? `  (source: ${r.source})` : "";
            return `${i + 1}. ${r.content}${src}`;
        });
        return `${header}\n${lines.join("\n")}`;
    }
    /** Bump recency/frequency counters (used by future consolidation phases). */
    markUsed(ids) {
        this.store.markUsed(ids);
    }
    stats() {
        return this.store.stats();
    }
    close() {
        this.store.close();
    }
}
//# sourceMappingURL=engram.js.map