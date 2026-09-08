import { ClaudeCliProvider, type ClaudeCliOptions } from "./claude-cli.js";
import { CodexCliProvider, type CodexCliOptions } from "./codex-cli.js";
import { CommandProvider, type CommandOptions } from "./command.js";

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

export type LLMConfig =
  | LLMProvider
  | ({ provider: "claude-cli" } & ClaudeCliOptions)
  | ({ provider: "codex-cli" } & CodexCliOptions)
  | ({ provider: "command" } & CommandOptions)
  | { provider: "none" };

function isProvider(x: LLMConfig): x is LLMProvider {
  return typeof (x as LLMProvider).complete === "function";
}

/**
 * Resolve an LLM config into a provider, or `null` when no LLM is configured
 * (engram then runs in pure hybrid-search mode — reranking is simply skipped).
 */
export function createLLMProvider(config?: LLMConfig): LLMProvider | null {
  if (!config) return null;
  if (isProvider(config)) return config;
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
