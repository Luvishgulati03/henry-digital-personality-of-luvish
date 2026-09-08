import { runCommand, runViaTmux } from "../util/exec.js";
import type { LLMCompleteOptions, LLMProvider } from "./provider.js";

export interface CommandOptions {
  /** The executable to run, e.g. "ollama". */
  command: string;
  /** Fixed args, e.g. ["run", "llama3"]. */
  args?: string[];
  /** How the prompt is delivered: piped to stdin (default) or appended as an arg. */
  promptVia?: "stdin" | "arg";
  useTmux?: boolean;
  timeoutMs?: number;
  name?: string;
}

/**
 * Generic provider for ANY text-in/text-out CLI (ollama, llamafile, a wrapper
 * script, …). The escape hatch that keeps engram model-agnostic.
 *
 * @example { provider: "command", command: "ollama", args: ["run", "llama3"] }
 */
export class CommandProvider implements LLMProvider {
  readonly name: string;
  private readonly command: string;
  private readonly args: string[];
  private readonly promptVia: "stdin" | "arg";
  private readonly useTmux: boolean;
  private readonly timeoutMs: number;

  constructor(opts: CommandOptions) {
    this.command = opts.command;
    this.args = opts.args ?? [];
    this.promptVia = opts.promptVia ?? "stdin";
    this.useTmux = opts.useTmux ?? false;
    this.timeoutMs = opts.timeoutMs ?? 90_000;
    this.name = opts.name ?? `command:${opts.command}`;
  }

  async complete(prompt: string, opts: LLMCompleteOptions = {}): Promise<string> {
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const finalArgs = this.promptVia === "arg" ? [...this.args, prompt] : [...this.args];
    const input = this.promptVia === "stdin" ? prompt : undefined;
    if (this.useTmux) {
      return (await runViaTmux(this.command, finalArgs, { input: input ?? "", timeoutMs })).trim();
    }
    return (await runCommand(this.command, finalArgs, { input, timeoutMs })).trim();
  }
}
