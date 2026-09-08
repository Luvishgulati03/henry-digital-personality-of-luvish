import { fnv1a } from "../util/hash.js";
import { l2normalize } from "../util/cosine.js";
import { meaningfulTokens } from "../util/text.js";
import type { EmbeddingProvider } from "./provider.js";

/**
 * Deterministic, offline "feature hashing" embedding (the hashing trick).
 *
 * Tokens (unigrams + bigrams) are hashed into a fixed-dim vector with a signed
 * bucket, then L2-normalised. It has NO learned semantics — "car" and
 * "automobile" don't converge — so it behaves like a smart lexical signal that
 * complements FTS5. That's intentional: it makes engram run with zero
 * dependencies and zero API keys for tests, demos, and air-gapped agents.
 *
 * For true semantic recall ("dentist" ~ "tooth pain"), swap in a real model via
 * the EmbeddingProvider interface (see OpenAIEmbeddingProvider).
 */
export class HashingEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dim: number;

  constructor(dim = 256) {
    this.dim = dim;
    this.name = `hashing-v1@${dim}`;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map((t) => this.embedOne(t));
  }

  private embedOne(text: string): Float32Array {
    const vec = new Float32Array(this.dim);
    const tokens = meaningfulTokens(text);
    const grams: string[] = [...tokens];
    for (let i = 0; i < tokens.length - 1; i++) {
      grams.push(`${tokens[i]}_${tokens[i + 1]}`);
    }
    for (const g of grams) {
      const h = fnv1a(g);
      const idx = h % this.dim;
      const sign = (h >>> 16) & 1 ? 1 : -1;
      vec[idx] = (vec[idx] ?? 0) + sign;
    }
    return l2normalize(vec);
  }
}
