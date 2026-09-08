import { runCommand, runViaTmux } from "../util/exec.js";
/**
 * Generic provider for ANY text-in/text-out CLI (ollama, llamafile, a wrapper
 * script, …). The escape hatch that keeps engram model-agnostic.
 *
 * @example { provider: "command", command: "ollama", args: ["run", "llama3"] }
 */
export class CommandProvider {
    name;
    command;
    args;
    promptVia;
    useTmux;
    timeoutMs;
    constructor(opts) {
        this.command = opts.command;
        this.args = opts.args ?? [];
        this.promptVia = opts.promptVia ?? "stdin";
        this.useTmux = opts.useTmux ?? false;
        this.timeoutMs = opts.timeoutMs ?? 90_000;
        this.name = opts.name ?? `command:${opts.command}`;
    }
    async complete(prompt, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
        const finalArgs = this.promptVia === "arg" ? [...this.args, prompt] : [...this.args];
        const input = this.promptVia === "stdin" ? prompt : undefined;
        if (this.useTmux) {
            return (await runViaTmux(this.command, finalArgs, { input: input ?? "", timeoutMs })).trim();
        }
        return (await runCommand(this.command, finalArgs, { input, timeoutMs })).trim();
    }
}
//# sourceMappingURL=command.js.map