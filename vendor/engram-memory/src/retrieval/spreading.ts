/**
 * Spreading activation — the mechanism that makes recall *associative*.
 *
 * Hybrid search answers "which memories look like the query?". Spreading
 * activation answers the harder, more human question: "given what the query
 * lit up, what else should come to mind?". We inject activation at the seed
 * memories (the hybrid hits) and let it flow outward along the graph's edges,
 * attenuating each hop. A memory that shares no words and no embedding overlap
 * with the query can still surface — because it sits one `lesson_from` or
 * `caused` edge away from something that did. That is the "dentist → the
 * lesson I learned about flossing" recall the flat index can never do.
 *
 * The model is a bounded, Personalized-PageRank-style diffusion:
 *
 *   - Each seed starts with activation = its hybrid relevance score.
 *   - A node distributes `activation × decay` to its neighbours, split across
 *     out-edges in proportion to edge weight (so a hub doesn't flood the graph,
 *     and a strong edge carries more than a weak one).
 *   - We run a fixed number of hops and accumulate *received* activation per
 *     node (a seed's own injected value is NOT counted as received — only what
 *     flows back to it from others is).
 *   - Tiny flows are pruned so the frontier stays small.
 *
 * The returned map is "how much did the graph light this node up, and via which
 * edge" — the caller fuses that as the fifth recall signal and turns the
 * provenance into a human-readable why-trace.
 */

import type { EdgeType, MemoryEdge, MemoryStore } from "../store/types.js";

export interface SpreadOptions {
  /** Per-hop attenuation in (0,1). Lower = activation dies out faster. Default 0.5. */
  decay?: number;
  /** How many hops to propagate. Default 2. */
  hops?: number;
  /** Restrict spreading to specific edge types (default: all). */
  edgeTypes?: EdgeType[];
  /** Flows below this are dropped (keeps the frontier sparse). Default 1e-4. */
  minActivation?: number;
}

/** How a node was lit up by the graph. */
export interface ActivationProvenance {
  /** The single strongest inflow edge type. */
  type: EdgeType;
  /** The neighbour the strongest activation came from. */
  from: string;
  /** Hop at which that strongest inflow arrived (1 = direct neighbour of a seed). */
  hop: number;
}

export interface Activation {
  id: string;
  /** Total activation received from the graph (excludes the node's own seed value). */
  activation: number;
  via: ActivationProvenance;
}

const DEFAULTS: Required<Omit<SpreadOptions, "edgeTypes">> = {
  decay: 0.5,
  hops: 2,
  minActivation: 1e-4,
};

/**
 * Diffuse activation outward from `seeds` (id → seed score) across the store's
 * edges. Returns received-activation per reached node, keyed by id; seeds only
 * appear if something flows *back* to them.
 */
export function spreadActivation(
  store: MemoryStore,
  seeds: Map<string, number>,
  opts: SpreadOptions = {},
): Map<string, Activation> {
  const decay = opts.decay ?? DEFAULTS.decay;
  const hops = opts.hops ?? DEFAULTS.hops;
  const minAct = opts.minActivation ?? DEFAULTS.minActivation;

  // Received activation accumulated across all hops, and best provenance so far.
  const received = new Map<string, number>();
  const provenance = new Map<string, { score: number; via: ActivationProvenance }>();

  // The active wavefront: how much "charge" each node will push outward next hop.
  let frontier = new Map<string, number>(seeds);

  for (let hop = 1; hop <= hops && frontier.size > 0; hop++) {
    const srcIds = [...frontier.keys()];
    const edges = store.edgesFrom(srcIds, opts.edgeTypes);

    // Group out-edges by source so each node can normalise across its own fan-out.
    const bySrc = new Map<string, MemoryEdge[]>();
    for (const e of edges) {
      const arr = bySrc.get(e.srcId) ?? [];
      arr.push(e);
      bySrc.set(e.srcId, arr);
    }

    const next = new Map<string, number>();
    for (const [src, charge] of frontier) {
      const out = bySrc.get(src);
      if (!out || out.length === 0) continue;
      const totalW = out.reduce((s, e) => s + e.weight, 0) || 1;
      for (const e of out) {
        const flow = charge * decay * (e.weight / totalW);
        if (flow < minAct) continue;

        received.set(e.dstId, (received.get(e.dstId) ?? 0) + flow);
        next.set(e.dstId, (next.get(e.dstId) ?? 0) + flow);

        // Keep the strongest single inflow as the "why" provenance.
        const prev = provenance.get(e.dstId);
        if (!prev || flow > prev.score) {
          provenance.set(e.dstId, { score: flow, via: { type: e.type, from: src, hop } });
        }
      }
    }
    frontier = next;
  }

  const result = new Map<string, Activation>();
  for (const [id, activation] of received) {
    const p = provenance.get(id)!;
    result.set(id, { id, activation, via: p.via });
  }
  return result;
}
