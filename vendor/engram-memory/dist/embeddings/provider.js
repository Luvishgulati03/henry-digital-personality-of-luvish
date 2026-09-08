import { HashingEmbeddingProvider } from "./hashing.js";
import { OpenAIEmbeddingProvider } from "./openai.js";
function isProvider(x) {
    return typeof x.embed === "function";
}
/**
 * Resolve a config (or a ready provider) into a provider instance.
 * Default — when nothing is supplied — is the offline, dependency-free hashing
 * provider, so engram works with zero setup and zero API keys.
 */
export function createEmbeddingProvider(config) {
    if (!config)
        return new HashingEmbeddingProvider();
    if (isProvider(config))
        return config;
    switch (config.provider) {
        case "openai":
            return new OpenAIEmbeddingProvider(config);
        case "hashing":
            return new HashingEmbeddingProvider(config.dim);
        default:
            return new HashingEmbeddingProvider();
    }
}
//# sourceMappingURL=provider.js.map