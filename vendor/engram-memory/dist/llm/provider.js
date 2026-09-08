import { ClaudeCliProvider } from "./claude-cli.js";
import { CodexCliProvider } from "./codex-cli.js";
import { CommandProvider } from "./command.js";
function isProvider(x) {
    return typeof x.complete === "function";
}
/**
 * Resolve an LLM config into a provider, or `null` when no LLM is configured
 * (engram then runs in pure hybrid-search mode — reranking is simply skipped).
 */
export function createLLMProvider(config) {
    if (!config)
        return null;
    if (isProvider(config))
        return config;
    switch (config.provider) {
        case "claude-cli":
            return new ClaudeCliProvider(config);
        case "codex-cli":
            return new CodexCliProvider(config);
        case "command":
            return new CommandProvider(config);
        case "none":
            return null;
        default:
            return null;
    }
}
//# sourceMappingURL=provider.js.map