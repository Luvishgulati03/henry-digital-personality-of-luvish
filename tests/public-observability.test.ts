import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventSampler, PublicLog, RotatingLog, loggablePath, logGenerations, maskContacts, readLogEntries } from "../src/public/log.ts";
import { formatEntry, isProblem, runPublicOpsCommand } from "../src/public/cli.ts";
import { teeServiceOutput } from "../bin/start.mjs";

/** The public request log, its rotation, `henry public logs|status`, and the `henry start` service log. */

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("RotatingLog: rotates by size and keeps exactly N files", () => {
  const dir = tmp("henry-rotate-");
  const file = path.join(dir, "logs", "public.log");
  const log = new RotatingLog(file, 100, 3);
  for (let index = 0; index < 20; index += 1) log.append(`${String(index).padStart(2, "0")} ${"x".repeat(36)}\n`);
  const generations = logGenerations(file, 3);
  assert.deepEqual(generations.map((name) => path.basename(name)), ["public.log.2", "public.log.1", "public.log"]);
  for (const generation of generations) assert.ok(fs.statSync(generation).size <= 100);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  const all = generations.flatMap((generation) => fs.readFileSync(generation, "utf8").split("\n").filter(Boolean));
  assert.equal(all.at(-1)?.slice(0, 2), "19", "the newest line is in the live file");
  assert.equal(all.length, 6, "older generations fall off");
});

test("loggablePath and maskContacts: no query, no contact details, capped", () => {
  assert.equal(loggablePath("/api/public/chat?x=secret"), "/api/public/chat");
  assert.equal(loggablePath("/contact/someone%40example.com"), "/contact/[masked]");
  assert.equal(loggablePath("/call/+44%207700%20900123"), "/call/[masked]");
  assert.ok(loggablePath(`/${"a".repeat(500)}`).length <= 160);
  assert.equal(maskContacts("mail me: a.b@example.org or 555-123-4567"), "mail me: [masked] or [masked]");
  assert.equal(maskContacts("vad.ready cdn 2400ms"), "vad.ready cdn 2400ms");
});

test("PublicLog: visitor ids are keyed HMACs, stable within a process, different across keys", () => {
  const dir = tmp("henry-plog-");
  const a = new PublicLog(dir, { key: Buffer.alloc(32, 1) });
  const b = new PublicLog(dir, { key: Buffer.alloc(32, 2) });
  const id = "abcdefghijklmnopqrstuvwx";
  assert.equal(a.visitorHash(id), a.visitorHash(id));
  assert.notEqual(a.visitorHash(id), b.visitorHash(id));
  assert.ok(!a.visitorHash(id)!.includes(id.slice(0, 6)));
  assert.equal(a.visitorHash(id)!.length, 12);
  assert.equal(new PublicLog(dir).visitorHash(undefined), undefined);
});

test("EventSampler: the first per window is recorded with how many were folded into the previous window", () => {
  let now = 0;
  const sampler = new EventSampler(60_000, () => now);
  assert.equal(sampler.take("rate"), 0);
  assert.equal(sampler.take("rate"), undefined);
  assert.equal(sampler.take("rate"), undefined);
  assert.equal(sampler.take("busy"), 0, "kinds are sampled separately");
  now = 61_000;
  assert.equal(sampler.take("rate"), 2);
});

function writeLog(dataDir: string, entries: Array<Record<string, unknown>>): void {
  fs.mkdirSync(path.join(dataDir, "logs"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "logs", "public.log"), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}

test("henry public status: dashboard/tunnel health, pack, visitors now, last turns, last-hour problem counts", async () => {
  const dataDir = tmp("henry-status-");
  const now = Date.parse("2026-09-25T12:00:00Z");
  const at = (minutesAgo: number) => new Date(now - minutesAgo * 60_000).toISOString();
  fs.mkdirSync(path.join(dataDir, "public-pack", "published"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "public-pack", "published", "01-about.md"), "# About\n");
  writeLog(dataDir, [
    { ts: at(90), kind: "request", method: "POST", path: "/api/public/chat", route: "POST /api/public/chat", status: 200, visitor: "old", totalMs: 9000 },
    { ts: at(30), kind: "tunnel", event: "lost", reason: "cloudflared exited" },
    { ts: at(29), kind: "tunnel", event: "reconnected", downMs: 60_000 },
    { ts: at(10), kind: "request", method: "POST", path: "/api/public/chat", route: "POST /api/public/chat", status: 200, visitor: "v1", provider: "claude", model: "sonnet", firstTextMs: 2100, firstSentMs: 2300, totalMs: 4100, streamed: 3 },
    { ts: at(5), kind: "request", method: "POST", path: "/api/public/chat", route: "POST /api/public/chat", status: 200, visitor: "v2", failed: "timeout", totalMs: 120000 },
    { ts: at(4), kind: "request", method: "POST", path: "/api/public/chat", route: "POST /api/public/chat", status: 429, visitor: "v2", rateLimited: true },
    { ts: at(3), kind: "request", method: "POST", path: "/api/public/client-log", route: "POST /api/public/client-log", status: 200, visitor: "v2", event: "vad.cdn_failed", detail: "cdn: script did not load" },
    { ts: at(2), kind: "request", method: "GET", path: "/", status: 200, owner: true, visitor: "owner" },
  ]);
  const lines: string[] = [];
  const fetcher = (async () => new Response(JSON.stringify({ ok: true, remote: { active: true } }), { status: 200 })) as typeof fetch;
  assert.equal(await runPublicOpsCommand({ dataDir, port: 1 }, "status", [], { out: (line) => lines.push(line), fetcher, now: () => now }), true);
  const text = lines.join("\n");
  assert.match(text, /Dashboard \(127\.0\.0\.1:1\): running/);
  assert.match(text, /Public link: UP/);
  assert.match(text, /Last tunnel event: .*tunnel reconnected down 60\.0s/);
  assert.match(text, /Published pack: 1 file, 8B/);
  assert.match(text, /Visitors in the last 15 minutes: 2/, "owner requests are not visitors");
  assert.match(text, /claude\/sonnet {2}first-text 2100ms {2}first-sent 2300ms {2}total 4100ms/);
  assert.match(text, /Last hour: 5 requests; 5xx 0, failed turns 1, timeouts 1, busy 0, rate-limited 1, guard-blocked 0, page errors 1, tunnel drops 1/);

  const down: string[] = [];
  const refused = (async () => { throw new Error("ECONNREFUSED"); }) as typeof fetch;
  await runPublicOpsCommand({ dataDir: tmp("henry-status-empty-"), port: 1 }, "status", [], { out: (line) => down.push(line), fetcher: refused, now: () => now });
  assert.match(down.join("\n"), /not reachable[\s\S]*unknown \(dashboard not running\)[\s\S]*Published pack: none/);
  await assert.rejects(runPublicOpsCommand({ dataDir, port: 1 }, "status", ["--x"], {}), /Usage/);
});

test("henry public logs: human lines, --errors filter, --json, -n, and --follow picks up new lines", async () => {
  const dataDir = tmp("henry-logs-");
  writeLog(dataDir, [
    { ts: "2026-09-25T10:00:00.000Z", kind: "request", method: "GET", path: "/public/chat", status: 200, ms: 3, bytes: 2048, tunnelled: true, visitor: "abc", ray: "8f00-LHR" },
    { ts: "2026-09-25T10:00:01.000Z", kind: "request", method: "POST", path: "/api/public/chat", route: "POST /api/public/chat", status: 200, ms: 4200, bytes: 900, tunnelled: true, blocked: true, totalMs: 4200 },
    { ts: "2026-09-25T10:00:02.000Z", kind: "tunnel", event: "lost", reason: "exited" },
  ]);
  const out: string[] = [];
  await runPublicOpsCommand({ dataDir, port: 1 }, "logs", [], { out: (line) => out.push(line) });
  assert.equal(out.length, 3);
  assert.match(out[0], /200 {2}GET \/public\/chat {2}3ms {2}2\.0KB {2}tunnel {2}v:abc {2}ray 8f00-LHR/);
  const errors: string[] = [];
  await runPublicOpsCommand({ dataDir, port: 1 }, "logs", ["--errors"], { out: (line) => errors.push(line) });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /blocked/);
  assert.match(errors[1], /tunnel lost \(exited\)/);
  const jsonLines: string[] = [];
  await runPublicOpsCommand({ dataDir, port: 1 }, "logs", ["--json", "-n", "1"], { out: (line) => jsonLines.push(line) });
  assert.equal(jsonLines.length, 1);
  assert.equal(JSON.parse(jsonLines[0]).kind, "tunnel");
  await assert.rejects(runPublicOpsCommand({ dataDir, port: 1 }, "logs", ["--nope"], {}), /Usage/);

  let stop!: () => void;
  const until = new Promise<void>((resolve) => { stop = resolve; });
  const followed: string[] = [];
  const running = runPublicOpsCommand({ dataDir, port: 1 }, "logs", ["--follow", "--errors", "-n", "1"], { out: (line) => followed.push(line), until });
  await new Promise((resolve) => setTimeout(resolve, 50));
  fs.appendFileSync(path.join(dataDir, "logs", "public.log"), JSON.stringify({ ts: "2026-09-25T10:00:03.000Z", kind: "request", method: "POST", path: "/api/public/chat", status: 500, failed: "threw" }) + "\n" + JSON.stringify({ ts: "2026-09-25T10:00:04.000Z", kind: "request", method: "GET", path: "/", status: 200 }) + "\n");
  await new Promise((resolve) => setTimeout(resolve, 1_300));
  stop();
  await running;
  assert.equal(followed.length, 2, "the last problem, then the new problem; the healthy request is filtered");
  assert.match(followed[1], /500 .*FAILED:threw/);
});

test("isProblem / formatEntry: a healthy vad.ready report is not a problem, a CDN failure is", () => {
  assert.equal(isProblem({ kind: "request", status: 200, event: "vad.ready" }), false);
  assert.equal(isProblem({ kind: "request", status: 200, event: "vad.cdn_failed" }), true);
  assert.equal(isProblem({ kind: "request", status: 503 }), true);
  assert.equal(isProblem({ kind: "tunnel", event: "reconnected" }), false);
  assert.match(formatEntry({ ts: "x", kind: "request", status: 200, method: "POST", path: "/api/public/client-log", event: "vad.ready", detail: "cdn 2400ms" }), /vad\.ready: cdn 2400ms/);
});

test("henry start service log: every line the window prints is timestamped into the rotating log, screen output unchanged", async () => {
  const written: string[] = [];
  const screen = { stdout: [] as string[], stderr: [] as string[] };
  const streams = {
    stdout: { write: (chunk: string | Uint8Array) => { screen.stdout.push(String(chunk)); return true; } },
    stderr: { write: (chunk: string | Uint8Array) => { screen.stderr.push(String(chunk)); return true; } },
  };
  const restore = await teeServiceOutput("/unused", { streams, createLog: () => ({ append: (text: string) => { written.push(text); } }), now: () => new Date("2026-09-25T12:00:00Z") });
  streams.stdout.write("Henry is ready.\nDashboard: http://127.0.0.1:7337\n");
  streams.stderr.write(Buffer.from("\u001b[33mRemote access lost: cloudflared exited\u001b[0m\npartial"));
  streams.stdout.write("Remote access reconnected\n");
  restore();
  assert.deepEqual(screen.stdout, ["Henry is ready.\nDashboard: http://127.0.0.1:7337\n", "Remote access reconnected\n"]);
  assert.equal(written[0], `2026-09-25T12:00:00.000Z --- henry start (pid ${process.pid}) ---\n`);
  assert.deepEqual(written.slice(1), [
    "2026-09-25T12:00:00.000Z Henry is ready.\n",
    "2026-09-25T12:00:00.000Z Dashboard: http://127.0.0.1:7337\n",
    "2026-09-25T12:00:00.000Z ! Remote access lost: cloudflared exited\n",
    "2026-09-25T12:00:00.000Z Remote access reconnected\n",
    "2026-09-25T12:00:00.000Z ! partial\n",
  ]);
  // After restore the streams are untouched.
  const before = written.length;
  streams.stdout.write("after\n");
  assert.equal(written.length, before);
});

test("readLogEntries skips torn lines", () => {
  const dir = tmp("henry-torn-");
  const file = path.join(dir, "public.log");
  fs.writeFileSync(file, '{"kind":"request"}\n{"kind":\n[1]\n{"kind":"tunnel"}\n');
  assert.deepEqual(readLogEntries(file).map((entry) => entry.kind), ["request", "tunnel"]);
});
