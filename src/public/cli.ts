import fs from "node:fs";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import { publicPackDir } from "./config.ts";
import { PUBLIC_LOG_FILE, START_LOG_FILE, logGenerations, logsDir, readLogEntries } from "./log.ts";

/**
 * `henry public logs [--follow] [--errors] [--start] [--json] [-n <lines>]` and `henry public status`:
 * the owner's view of the public surface, read from `<dataDir>/logs/` and the local /api/health.
 * Read-only: nothing here touches memory, approvals, the tunnel, or the running server.
 */

type Entry = Record<string, unknown>;

export interface PublicOpsDeps {
  out: (line: string) => void;
  fetcher: typeof fetch;
  now: () => number;
  /** Resolves when a --follow should stop (tests); production follows until Ctrl+C. */
  until?: Promise<void>;
}

const USAGE = "Usage: henry public logs [--follow] [--errors] [--start] [--json] [-n <lines>] | henry public status | henry public pack ...";
const CHAT_ROUTE = "POST /api/public/chat";

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function ms(value: unknown): string {
  const n = num(value);
  if (n === undefined) return "-";
  return n >= 10_000 ? `${(n / 1000).toFixed(1)}s` : `${Math.round(n)}ms`;
}

function size(value: unknown): string {
  const n = num(value) ?? 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;
}

function clock(ts: unknown): string {
  if (typeof ts !== "string") return "--:--:--";
  const date = new Date(ts);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("en-GB", { hour12: false });
}

/** Whether an entry records something going wrong or being refused. */
export function isProblem(entry: Entry): boolean {
  if (entry.kind === "tunnel") return entry.event === "lost" || entry.event === "failed";
  if (entry.kind !== "request") return false;
  const status = num(entry.status) ?? 0;
  if (status >= 500) return true;
  if (entry.failed || entry.blocked || entry.busy || entry.rateLimited || entry.replaced) return true;
  if (typeof entry.event === "string" && entry.event !== "vad.ready") return true;
  return entry.aborted === true && entry.route === CHAT_ROUTE;
}

/** One human line per log entry. */
export function formatEntry(entry: Entry): string {
  const time = clock(entry.ts);
  if (entry.kind === "tunnel") {
    const extra = [entry.reason ? `(${String(entry.reason)})` : "", entry.downMs !== undefined ? `down ${ms(entry.downMs)}` : "", entry.restarts ? `restarts ${String(entry.restarts)}` : ""].filter(Boolean).join(" ");
    return `${time}  tunnel ${String(entry.event ?? "?")}${extra ? ` ${extra}` : ""}`;
  }
  if (entry.kind !== "request") return `${time}  ${String(entry.kind ?? "?")} ${JSON.stringify(entry)}`;
  const parts = [
    time,
    String(entry.status ?? "---"),
    `${String(entry.method ?? "?")} ${String(entry.path ?? "?")}`,
    ms(entry.ms),
    size(entry.bytes),
    entry.tunnelled ? "tunnel" : "local",
  ];
  if (entry.owner) parts.push("owner");
  if (typeof entry.visitor === "string") parts.push(`v:${entry.visitor}`);
  if (entry.provider || entry.model) parts.push(`${String(entry.provider ?? "?")}${entry.model ? `/${String(entry.model)}` : ""}`);
  if (entry.firstTextMs !== undefined && entry.firstTextMs !== null) parts.push(`first-text ${ms(entry.firstTextMs)}`);
  if (entry.firstSentMs !== undefined && entry.firstSentMs !== null) parts.push(`first-sent ${ms(entry.firstSentMs)}`);
  if (entry.totalMs !== undefined) parts.push(`total ${ms(entry.totalMs)}`);
  if (entry.queueMs) parts.push(`queued ${ms(entry.queueMs)}`);
  if (entry.sttMs !== undefined) parts.push(`stt ${ms(entry.sttMs)}`);
  if (entry.ttsMs !== undefined) parts.push(`tts ${ms(entry.ttsMs)}`);
  if (entry.streamed) parts.push(`${String(entry.streamed)} sentences`);
  for (const flag of ["voice", "blocked", "replaced", "busy", "rateLimited", "aborted"]) if (entry[flag] === true) parts.push(flag);
  if (entry.failed) parts.push(`FAILED:${String(entry.failed)}`);
  if (typeof entry.event === "string") parts.push(`${entry.event}${entry.detail ? `: ${String(entry.detail)}` : ""}`);
  if (typeof entry.ray === "string") parts.push(`ray ${entry.ray}`);
  return parts.join("  ");
}

function parseLine(line: string): Entry | undefined {
  try {
    const parsed = JSON.parse(line) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Entry : undefined;
  } catch { return undefined; }
}

/** Prints new lines appended to `file` until `until` resolves (rotation-aware: a shrink restarts at 0). */
async function follow(file: string, onLine: (line: string) => void, until: Promise<void>): Promise<void> {
  let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
  let carry = "";
  const poll = (): void => {
    let stat: fs.Stats;
    try { stat = fs.statSync(file); } catch { return; }
    if (stat.size < offset) { offset = 0; carry = ""; }
    if (stat.size === offset) return;
    const fd = fs.openSync(file, "r");
    try {
      const buffer = Buffer.alloc(stat.size - offset);
      fs.readSync(fd, buffer, 0, buffer.length, offset);
      offset = stat.size;
      const lines = (carry + buffer.toString("utf8")).split("\n");
      carry = lines.pop() ?? "";
      for (const line of lines) if (line.trim()) onLine(line);
    } finally { fs.closeSync(fd); }
  };
  const timer = setInterval(poll, 1_000);
  try { await until; } finally { clearInterval(timer); poll(); }
}

async function logsCommand(config: Pick<HenryConfig, "dataDir">, args: string[], deps: PublicOpsDeps): Promise<void> {
  const known = new Set(["--follow", "-f", "--errors", "--start", "--json", "-n"]);
  const countIndex = args.indexOf("-n");
  const count = countIndex >= 0 ? Number.parseInt(args[countIndex + 1] ?? "", 10) : 50;
  const unknown = args.filter((arg, index) => !known.has(arg) && !(countIndex >= 0 && index === countIndex + 1));
  if (unknown.length || !Number.isFinite(count) || count < 1) throw new Error(USAGE);
  const followMode = args.includes("--follow") || args.includes("-f");
  const until = deps.until ?? new Promise<void>((resolve) => { process.once("SIGINT", () => resolve()); });

  if (args.includes("--start")) {
    // The service window's own output (henry start), timestamped and rotated.
    const file = path.join(logsDir(config.dataDir), START_LOG_FILE);
    const lines = logGenerations(file).flatMap((generation) => fs.readFileSync(generation, "utf8").split("\n").filter((line) => line.trim()));
    if (!lines.length && !followMode) { deps.out(`No service log yet at ${file}. It is written by henry start.`); return; }
    for (const line of lines.slice(-count)) deps.out(line);
    if (followMode) await follow(file, deps.out, until);
    return;
  }

  const file = path.join(logsDir(config.dataDir), PUBLIC_LOG_FILE);
  const errorsOnly = args.includes("--errors");
  const json = args.includes("--json");
  const show = (entry: Entry, raw?: string): void => {
    if (errorsOnly && !isProblem(entry)) return;
    deps.out(json ? raw ?? JSON.stringify(entry) : formatEntry(entry));
  };
  const entries = readLogEntries(file).filter((entry) => !errorsOnly || isProblem(entry));
  if (!entries.length && !followMode) deps.out(`No public requests logged yet${errorsOnly ? " with problems" : ""} (${file}).`);
  for (const entry of entries.slice(-count)) show(entry);
  if (followMode) await follow(file, (line) => { const entry = parseLine(line); if (entry) show(entry, line); }, until);
}

interface PackInfo { files: number; bytes: number; newest?: string }

function packInfo(dataDir: string): PackInfo | undefined {
  const dir = publicPackDir(dataDir);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((name) => name.endsWith(".md")); } catch { return undefined; }
  let bytes = 0; let newest = 0;
  for (const name of names) {
    try { const stat = fs.statSync(path.join(dir, name)); bytes += stat.size; newest = Math.max(newest, stat.mtimeMs); } catch { /* raced */ }
  }
  return { files: names.length, bytes, ...(newest ? { newest: new Date(newest).toISOString() } : {}) };
}

async function statusCommand(config: Pick<HenryConfig, "dataDir" | "port">, deps: PublicOpsDeps): Promise<void> {
  const out = deps.out;
  const at = deps.now();
  let health: { ok?: boolean; remote?: { active?: boolean } } | undefined;
  try {
    const response = await deps.fetcher(`http://127.0.0.1:${config.port}/api/health`, { signal: AbortSignal.timeout(2_000), redirect: "error" });
    health = response.ok ? await response.json() as typeof health : undefined;
  } catch { health = undefined; }
  out(`Dashboard (127.0.0.1:${config.port}): ${health?.ok ? "running" : "not reachable"}`);
  out(`Public link: ${health?.ok ? (health.remote?.active ? "UP (tunnel connected)" : "DOWN (tunnel not connected; start with henry start --public)") : "unknown (dashboard not running)"}`);

  const entries = readLogEntries(path.join(logsDir(config.dataDir), PUBLIC_LOG_FILE));
  const lastTunnel = [...entries].reverse().find((entry) => entry.kind === "tunnel");
  if (lastTunnel) out(`Last tunnel event: ${formatEntry(lastTunnel).trim()}`);

  const pack = packInfo(config.dataDir);
  out(pack && pack.files
    ? `Published pack: ${pack.files} file${pack.files === 1 ? "" : "s"}, ${size(pack.bytes)}${pack.newest ? `, last published ${pack.newest}` : ""}`
    : `Published pack: none (${publicPackDir(config.dataDir)})`);

  const since = (windowMs: number) => entries.filter((entry) => {
    const t = typeof entry.ts === "string" ? Date.parse(entry.ts) : Number.NaN;
    return Number.isFinite(t) && at - t <= windowMs;
  });
  const recent = since(15 * 60_000).filter((entry) => entry.kind === "request" && typeof entry.visitor === "string" && !entry.owner);
  out(`Visitors in the last 15 minutes: ${new Set(recent.map((entry) => entry.visitor)).size}`);

  const turns = entries.filter((entry) => entry.kind === "request" && entry.route === CHAT_ROUTE && (entry.totalMs !== undefined || entry.failed || entry.busy || entry.rateLimited)).slice(-10);
  out(turns.length ? "Last turns:" : "Last turns: none logged yet");
  for (const turn of turns) out(`  ${formatEntry(turn)}`);

  const hour = since(60 * 60_000);
  const requests = hour.filter((entry) => entry.kind === "request");
  const counts: Array<[string, number]> = [
    ["5xx", requests.filter((entry) => (num(entry.status) ?? 0) >= 500).length],
    ["failed turns", requests.filter((entry) => entry.route === CHAT_ROUTE && entry.failed).length],
    ["timeouts", requests.filter((entry) => entry.failed === "timeout").length],
    ["busy", requests.filter((entry) => entry.busy === true).length],
    ["rate-limited", requests.filter((entry) => entry.rateLimited === true).length],
    ["guard-blocked", requests.filter((entry) => entry.blocked === true).length],
    ["page errors", requests.filter((entry) => typeof entry.event === "string" && entry.event !== "vad.ready").length],
    ["tunnel drops", hour.filter((entry) => entry.kind === "tunnel" && entry.event === "lost").length],
  ];
  out(`Last hour: ${requests.length} requests; ${counts.map(([name, value]) => `${name} ${value}`).join(", ")}`);
}

/** `henry public logs|status`. Returns false when `sub` is not one of them (the caller handles `pack`). */
export async function runPublicOpsCommand(
  config: Pick<HenryConfig, "dataDir" | "port">,
  sub: string | undefined,
  args: string[],
  deps: Partial<PublicOpsDeps> = {},
): Promise<boolean> {
  const full: PublicOpsDeps = { out: deps.out ?? ((line) => console.log(line)), fetcher: deps.fetcher ?? fetch, now: deps.now ?? Date.now, ...(deps.until ? { until: deps.until } : {}) };
  if (sub === "logs") { await logsCommand(config, args, full); return true; }
  if (sub === "status") {
    if (args.length) throw new Error(USAGE);
    await statusCommand(config, full);
    return true;
  }
  return false;
}

export const PUBLIC_OPS_USAGE = USAGE;
