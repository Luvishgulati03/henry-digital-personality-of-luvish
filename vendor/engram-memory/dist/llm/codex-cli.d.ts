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
export declare class CodexCliProvider implements LLMProvider {
    readonly name: string;
    private readonly model;
    private readonly useTmux;
    private readonly bin;
    private readonly extraArgs;
    private readonly timeoutMs;
    constructor(opts?: CodexCliOptions);
    complete(prompt: string, opts?: LLMCompleteOptions): Promise<string>;
}
//# sourceMappingURL=codex-cli.d.ts.map