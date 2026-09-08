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
export declare class HashingEmbeddingProvider implements EmbeddingProvider {
    readonly name: string;
    readonly dim: number;
    constructor(dim?: number);
    embed(texts: string[]): Promise<Float32Array[]>;
    private embedOne;
}
//# sourceMappingURL=hashing.d.ts.map