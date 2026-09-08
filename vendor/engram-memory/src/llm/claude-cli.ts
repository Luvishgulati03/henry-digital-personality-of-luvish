import { runCommand, runViaTmux } from "../util/exec.js";
import type { LLMCompleteOptions, LLMProvider } from "./provider.js";

export interface ClaudeCliOptions {
  /** Model alias or id, e.g. "sonnet", "opus", "haiku", or a full model id. */
  model?: string;
  /** Run via a detached ("silent") tmux session instead of a direct subprocess. */
  useTmux?: boolean;
  /** Path to the claude binary (default "claude"). */
  bin?: string;
  /** Extra flags appended to every invocation. */
  extraArgs?: string[];
  timeoutMs?: number;
}

/**
 * Uses the Claude Code CLI (`claude -p`) as the LLM — i.e. your Claude
 * subscription, no API key. Output format is plain text; the prompt is passed
 * as an argv element (direct mode) or via stdin (tmux mode), so no escaping is
 * needed.
 */
export class ClaudeCliProvider implements LLMProvider {
  readonly name: string;
  private readonly model: string;
  private readonly useTmux: boolean;
  private readonly bin: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;

  constructor(opts: ClaudeCliOptions = {}) {
    this.model = opts.model ?? "sonnet";
    this.useTmux = opts.useTmux ?? false;
    this.bin = opts.bin ?? "claude";
    this.extraArgs = opts.extraArgs ?? [];
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.name = `claude-cli:${this.model}${this.useTmux ? "+tmux" : ""}`;
  }

  async complete(prompt: string, opts: LLMCompleteOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const flags = ["--model", this.model, "--output-format", "text", ...this.extraArgs];
    if (this.useTmux) {
      // prompt arrives via stdin (file redirect) inside the tmux session
      return (await runViaTmux(this.bin, ["-p", ...flags], { input: prompt, timeoutMs })).trim();
    }
    // Prompt via stdin (like tmux mode) rather than argv: a large tagging batch
    // as a single argv element can exceed the OS ARG_MAX and fail with E2BIG.
    return (await runCommand(this.bin, ["-p", ...flags], { input: prompt, timeoutMs })).trim();
  }
}
