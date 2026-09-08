import { runCommand, runViaTmux } from "../util/exec.js";
/**
 * Uses the Claude Code CLI (`claude -p`) as the LLM — i.e. your Claude
 * subscription, no API key. Output format is plain text; the prompt is passed
 * as an argv element (direct mode) or via stdin (tmux mode), so no escaping is
 * needed.
 */
export class ClaudeCliProvider {
    name;
    model;
    useTmux;
    bin;
    extraArgs;
    timeoutMs;
    constructor(opts = {}) {
        this.model = opts.model ?? "sonnet";
        this.useTmux = opts.useTmux ?? false;
        this.bin = opts.bin ?? "claude";
        this.extraArgs = opts.extraArgs ?? [];
        this.timeoutMs = opts.timeoutMs ?? 90_000;
        this.name = `claude-cli:${this.model}${this.useTmux ? "+tmux" : ""}`;
    }
    async complete(prompt, opts = {}) {
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
//# sourceMappingURL=claude-cli.js.map