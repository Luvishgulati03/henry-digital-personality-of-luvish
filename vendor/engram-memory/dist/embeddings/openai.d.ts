import type { EmbeddingProvider } from "./provider.js";
export interface OpenAIEmbeddingOptions {
    apiKey?: string;
    model?: string;
    /** Optional reduced dimensionality (text-embedding-3-* support this). */
    dim?: number;
    baseUrl?: string;
}
/**
 * Real semantic embeddings via the OpenAI embeddings API.
 *
 * Optional by design: engram never requires it. Supply an API key (arg or
 * OPENAI_API_KEY env) to upgrade from lexical-only recall to true semantic
 * recall. Uses the global `fetch` (Node 18+), so it adds no dependency.
 */
export declare class OpenAIEmbeddingProvider implements EmbeddingProvider {
    readonly name: string;
    readonly dim: number;
    private readonly apiKey;
    private readonly model;
    private readonly baseUrl;
    private readonly requestedDim?;
    constructor(opts?: OpenAIEmbeddingOptions);
    embed(texts: string[]): Promise<Float32Array[]>;
}
//# sourceMappingURL=openai.d.ts.map