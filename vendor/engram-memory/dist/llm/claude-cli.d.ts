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
export declare class ClaudeCliProvider implements LLMProvider {
    readonly name: string;
    private readonly model;
    private readonly useTmux;
    private readonly bin;
    private readonly extraArgs;
    private readonly timeoutMs;
    constructor(opts?: ClaudeCliOptions);
    complete(prompt: string, opts?: LLMCompleteOptions): Promise<string>;
}
//# sourceMappingURL=claude-cli.d.ts.map