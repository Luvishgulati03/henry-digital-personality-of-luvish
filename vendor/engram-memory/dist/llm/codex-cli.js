import { runCommand, runViaTmux } from "../util/exec.js";
/**
 * Uses the OpenAI Codex CLI (`codex exec`) as the LLM — i.e. your ChatGPT/Codex
 * subscription, no API key. Runs non-interactively. Codex may emit progress on
 * stderr; the final message lands on stdout, and engram's parsers extract the
 * JSON/number they need robustly from it.
 */
export class CodexCliProvider {
    name;
    model;
    useTmux;
    bin;
    extraArgs;
    timeoutMs;
    constructor(opts = {}) {
        this.model = opts.model;
        this.useTmux = opts.useTmux ?? false;
        this.bin = opts.bin ?? "codex";
        this.extraArgs = opts.extraArgs ?? [];
        this.timeoutMs = opts.timeoutMs ?? 120_000;
        this.name = `codex-cli:${this.model ?? "default"}${this.useTmux ? "+tmux" : ""}`;
    }
    async complete(prompt, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
        const flags = ["exec", "--skip-git-repo-check"];
        if (this.model)
            flags.push("-m", this.model);
        flags.push(...this.extraArgs);
        if (this.useTmux) {
            return (await runViaTmux(this.bin, flags, { input: prompt, timeoutMs })).trim();
        }
        return (await runCommand(this.bin, [...flags, prompt], { timeoutMs })).trim();
    }
}
//# sourceMappingURL=codex-cli.js.map