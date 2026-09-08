import { type ClaudeCliOptions } from "./claude-cli.js";
import { type CodexCliOptions } from "./codex-cli.js";
import { type CommandOptions } from "./command.js";
/**
 * The LLM contract. Any text-in/text-out model can power engram's reasoning
 * features (reranking, importance scoring). Crucially, the built-in providers
 * shell out to *subscription CLIs* (`claude`, `codex`) — so you use the plan you
 * already pay for, with no API keys.
 */
export interface LLMProvider {
    readonly name: string;
    complete(prompt: string, opts?: LLMCompleteOptions): Promise<string>;
}
export interface LLMCompleteOptions {
    timeoutMs?: number;
}
export type LLMConfig = LLMProvider | ({
    provider: "claude-cli";
} & ClaudeCliOptions) | ({
    provider: "codex-cli";
} & CodexCliOptions) | ({
    provider: "command";
} & CommandOptions) | {
    provider: "none";
};
/**
 * Resolve an LLM config into a provider, or `null` when no LLM is configured
 * (engram then runs in pure hybrid-search mode — reranking is simply skipped).
 */
export declare function createLLMProvider(config?: LLMConfig): LLMProvider | null;
//# sourceMappingURL=provider.d.ts.map