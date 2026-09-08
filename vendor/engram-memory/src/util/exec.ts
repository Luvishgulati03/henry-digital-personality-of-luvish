import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface RunOptions {
  /** Hard timeout; the process is killed and the call rejects when exceeded. */
  timeoutMs?: number;
  /** If set, written to the child's stdin (then stdin is closed). */
  input?: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Run a command as a direct child process and resolve with its stdout.
 * Args are passed as an array (no shell), so prompts with quotes/newlines are
 * safe — no escaping required.
 */
export function runCommand(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 60_000;
    const child = spawn(cmd, args, {
      stdio: [opts.input !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`command timed out after ${timeoutMs}ms: ${cmd}`));
    }, timeoutMs);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited ${code}: ${(err || out).slice(0, 500)}`));
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

/**
 * Run a command inside a detached ("silent") tmux session.
 *
 * Some subscription CLIs behave best inside a tmux/TTY context. This launches
 * the command in a background tmux session with the prompt piped from a file and
 * stdout/stderr captured to files, polls for a sentinel, then returns stdout.
 * Everything is written to temp files, so no shell-escaping of the prompt.
 */
export async function runViaTmux(bin: string, args: string[], opts: RunOptions = {}): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "engram-tmux-"));
  const promptFile = join(dir, "prompt.txt");
  const outFile = join(dir, "out.txt");
  const errFile = join(dir, "err.txt");
  const doneFile = join(dir, "done");
  const scriptFile = join(dir, "run.sh");
  const session = `engram-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  writeFileSync(promptFile, opts.input ?? "");
  const quoted = args.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" ");
  const script =
    `#!/bin/sh\n'${bin}' ${quoted} < '${promptFile}' > '${outFile}' 2> '${errFile}'\n` +
    `echo $? > '${doneFile}'\n`;
  writeFileSync(scriptFile, script, { mode: 0o755 });

  const cleanup = () => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };

  await runCommand("tmux", ["new-session", "-d", "-s", session, "sh", scriptFile], {
    timeoutMs: 10_000,
  }).catch((e: unknown) => {
    cleanup();
    throw new Error(`tmux launch failed: ${e instanceof Error ? e.message : String(e)}`);
  });

  const timeoutMs = opts.timeoutMs ?? 90_000;
  const start = Date.now();
  while (!existsSync(doneFile)) {
    if (Date.now() - start > timeoutMs) {
      await runCommand("tmux", ["kill-session", "-t", session], {}).catch(() => {});
      cleanup();
      throw new Error(`tmux command timed out after ${timeoutMs}ms`);
    }
    await sleep(200);
  }

  const code = readFileSync(doneFile, "utf8").trim();
  const out = existsSync(outFile) ? readFileSync(outFile, "utf8") : "";
  const err = existsSync(errFile) ? readFileSync(errFile, "utf8") : "";
  await runCommand("tmux", ["kill-session", "-t", session], {}).catch(() => {});
  cleanup();
  if (code !== "0") throw new Error(`tmux command exited ${code}: ${(err || out).slice(0, 500)}`);
  return out;
}
