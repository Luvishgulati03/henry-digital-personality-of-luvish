import { runCommand, runViaTmux } from "../util/exec.js";
import type { LLMCompleteOptions, LLMProvider } from "./provider.js";

export interface CodexCliOptions {
  /** Model id, e.g. "gpt-5-codex", "o4-mini". Omit to use codex's configured default. */
  model?: string;
  useTmux?: boolean;
  /** Path to the codex binary (default "codex"). */
  bin?: string;
  extraArgs?: string[];
  timeoutMs?: number;
}

/**
 * Uses the OpenAI Codex CLI (`codex exec`) as the LLM — i.e. your ChatGPT/Codex
 * subscription, no API key. Runs non-interactively. Codex may emit progress on
 * stderr; the final message lands on stdout, and engram's parsers extract the
 * JSON/number they need robustly from it.
 */
export class CodexCliProvider implements LLMProvider {
  readonly name: string;
  private readonly model: string | undefined;
  private readonly useTmux: boolean;
  private readonly bin: string;
  private readonly extraArgs: string[];
  private readonly timeoutMs: number;

  constructor(opts: CodexCliOptions = {}) {
    this.model = opts.model;
    this.useTmux = opts.useTmux ?? false;
    this.bin = opts.bin ?? "codex";
    this.extraArgs = opts.extraArgs ?? [];
    this.timeoutMs = opts.timeoutMs ?? 120_000;
    this.name = `codex-cli:${this.model ?? "default"}${this.useTmux ? "+tmux" : ""}`;
  }

  async complete(prompt: string, opts: LLMCompleteOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const flags = ["exec", "--skip-git-repo-check"];
    if (this.model) flags.push("-m", this.model);
    flags.push(...this.extraArgs);
    if (this.useTmux) {
      return (await runViaTmux(this.bin, flags, { input: prompt, timeoutMs })).trim();
    }
    return (await runCommand(this.bin, [...flags, prompt], { timeoutMs })).trim();
  }
}
