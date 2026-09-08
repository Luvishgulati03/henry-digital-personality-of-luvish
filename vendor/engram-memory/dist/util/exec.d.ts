export interface RunOptions {
    /** Hard timeout; the process is killed and the call rejects when exceeded. */
    timeoutMs?: number;
    /** If set, written to the child's stdin (then stdin is closed). */
    input?: string;
}
/**
 * Run a command as a direct child process and resolve with its stdout.
 * Args are passed as an array (no shell), so prompts with quotes/newlines are
 * safe — no escaping required.
 */
export declare function runCommand(cmd: string, args: string[], opts?: RunOptions): Promise<string>;
/**
 * Run a command inside a detached ("silent") tmux session.
 *
 * Some subscription CLIs behave best inside a tmux/TTY context. This launches
 * the command in a background tmux session with the prompt piped from a file and
 * stdout/stderr captured to files, polls for a sentinel, then returns stdout.
 * Everything is written to temp files, so no shell-escaping of the prompt.
 */
export declare function runViaTmux(bin: string, args: string[], opts?: RunOptions): Promise<string>;
//# sourceMappingURL=exec.d.ts.map