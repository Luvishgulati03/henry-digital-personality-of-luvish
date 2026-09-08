/**
 * The embedding contract. Anything that turns text into a fixed-length vector
 * can be an engram memory's "semantic sense". Implement this to plug in a local
 * model (e.g. @xenova/transformers), Cohere, Voyage, etc.
 */
export interface EmbeddingProvider {
    /** Stable id stored alongside each vector, e.g. "hashing-v1@256". */
    readonly name: string;
    /** Output dimensionality. Vectors of different dims are never compared. */
    readonly dim: number;
    embed(texts: string[]): Promise<Float32Array[]>;
}
export type EmbeddingConfig = EmbeddingProvider | {
    provider: "hashing";
    dim?: number;
} | {
    provider: "openai";
    apiKey?: string;
    model?: string;
    dim?: number;
};
/**
 * Resolve a config (or a ready provider) into a provider instance.
 * Default — when nothing is supplied — is the offline, dependency-free hashing
 * provider, so engram works with zero setup and zero API keys.
 */
export declare function createEmbeddingProvider(config?: EmbeddingConfig): EmbeddingProvider;
//# sourceMappingURL=provider.d.ts.map