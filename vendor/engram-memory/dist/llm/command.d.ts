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
export declare class CommandProvider implements LLMProvider {
    readonly name: string;
    private readonly command;
    private readonly args;
    private readonly promptVia;
    private readonly useTmux;
    private readonly timeoutMs;
    constructor(opts: CommandOptions);
    complete(prompt: string, opts?: LLMCompleteOptions): Promise<string>;
}
//# sourceMappingURL=command.d.ts.map