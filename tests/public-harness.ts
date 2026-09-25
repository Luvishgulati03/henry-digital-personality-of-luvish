import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard, type DashboardVoice } from "../src/dashboard/server.ts";
import { resetLoginThrottleForTests } from "../src/dashboard/auth.ts";
import { publicModeConfig, type PublicModeConfig } from "../src/public/config.ts";
import type { RunOptions } from "../src/providers/runner.ts";
import type { ProviderEvent, RunResult } from "../src/types.ts";
import { PublicLog } from "../src/public/log.ts";

/**
 * A loopback dashboard on a temp root with the public face wired to fakes: a scripted provider
 * runner (records every prompt and option), a fake voice, an in-memory memory, and a recording
 * owner-send. `tunnel()` builds headers that make a request look like it came through Cloudflare.
 */

export const PUBLIC_ORIGIN = "https://henry.example.com";
export const OWNER_NAME = "Alex Example";

export function tone(samples = 160, rate = 16000): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  return wav;
}

export interface PublicHarness {
  base: string;
  runtime: HenryRuntime;
  runs: Array<{ prompt: string; options: RunOptions }>;
  reply: { current: string | ((prompt: string) => string | Promise<string>) };
  /**
   * When set, the fake runner plays these provider events through options.onEvent (one per tick,
   * like a real CLI's stdout) and answers with them; `error` makes the run fail as the runner would.
   */
  stream: { current?: (prompt: string) => { events: ProviderEvent[]; error?: string } };
  /** The public request log, with a fixed HMAC key. */
  log: PublicLog;
  sends: string[];
  notes: Array<{ content: string; input: Record<string, unknown> | undefined }>;
  tts: string[];
  stt: number[];
  sweep(): Promise<number>;
  close(): Promise<void>;
}

export function packDir(root: string): string {
  return path.join(root, "data", "public-pack", "published");
}

export async function publicHarness(options: { pack?: boolean; mode?: Partial<PublicModeConfig>; now?: () => number } = {}): Promise<PublicHarness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-public-e2e-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  process.env.HENRY_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  resetLoginThrottleForTests();
  const runtime = await HenryRuntime.create(root);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  runtime.config.ownerName = OWNER_NAME;
  if (options.pack !== false) {
    fs.mkdirSync(packDir(root), { recursive: true });
    fs.writeFileSync(path.join(packDir(root), "01-about.md"), "# About\nAlex Example builds products.\n");
  }
  const runs: PublicHarness["runs"] = [];
  const reply: PublicHarness["reply"] = { current: "Alex Example builds products." };
  const stream: PublicHarness["stream"] = {};
  const runner = {
    run: async (prompt: string, runOptions: RunOptions): Promise<RunResult> => {
      runs.push({ prompt, options: runOptions });
      if (stream.current) {
        const scripted = stream.current(prompt);
        for (const event of scripted.events) {
          await new Promise((resolve) => setImmediate(resolve));
          runOptions.onEvent?.(event);
        }
        const result = [...scripted.events].reverse().find((event) => event.parsed?.type === "result");
        const text = typeof result?.parsed?.result === "string" ? result.parsed.result : "";
        return { runId: `run-${runs.length}`, provider: "claude", response: scripted.error ? "" : text, exitCode: scripted.error ? 1 : 0, durationMs: 1, events: scripted.events, firstTextMs: 5, ...(scripted.error ? { error: scripted.error } : {}) };
      }
      const text = typeof reply.current === "function" ? await reply.current(prompt) : reply.current;
      return {
        runId: `run-${runs.length}`, provider: "claude", response: text, exitCode: 0, durationMs: 1,
        events: [{ timestamp: "", stream: "stdout", text: "", parsed: { type: "result", result: text, is_error: false } }],
      };
    },
  };
  const sends: string[] = [];
  const notes: PublicHarness["notes"] = [];
  const tts: string[] = [];
  const stt: number[] = [];
  const voice = {
    sttEnabled: () => true,
    ttsEnabled: () => true,
    transcribe: async (audio: Buffer) => { stt.push(audio.length); return { text: "What does Alex Example build?" }; },
    synthesize: async (text: string) => { tts.push(text); return tone(); },
  } as unknown as DashboardVoice;
  const mode: PublicModeConfig = { ...publicModeConfig(runtime.config, {}), ...options.mode };
  let sweep: () => Promise<number> = async () => 0;
  const log = new PublicLog(runtime.config.dataDir, { key: Buffer.alloc(32, 7) });
  const server = startDashboard(runtime, {
    voice,
    publicLog: log,
    warmVoicePrompts: false,
    publicSurface: {
      runner,
      mode,
      sweepIntervalMs: 0,
      memory: { remember: async (content, input) => { notes.push({ content, input }); return `mem-${notes.length}`; } },
      ...(options.now ? { now: options.now } : {}),
    },
    ownerSend: async (text) => { sends.push(text); return true; },
    onPublicSurface: (surface) => { sweep = () => surface.sweepIdle(); },
  });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`,
    runtime, runs, reply, stream, log, sends, notes, tts, stt,
    sweep: () => sweep(),
    async close() {
      await new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); });
      runtime.close();
      delete process.env.HENRY_PUBLIC_ORIGIN;
      resetLoginThrottleForTests();
    },
  };
}

/** Headers that make a request look like it arrived through the Cloudflare tunnel. */
export function tunnel(extra: Record<string, string> = {}, ip = "203.0.113.7"): Record<string, string> {
  return { "cf-connecting-ip": ip, "cf-ray": "8f00000000000000-LHR", "x-forwarded-proto": "https", "x-forwarded-for": ip, ...extra };
}

/** Collects `name=value` pairs from Set-Cookie headers into one Cookie header value. */
export function cookieFrom(response: Response, existing = ""): string {
  const jar = new Map(existing.split(";").map((part) => part.trim()).filter(Boolean).map((part) => [part.split("=")[0], part] as const));
  for (const header of response.headers.getSetCookie()) {
    const pair = header.split(";")[0];
    jar.set(pair.split("=")[0], pair);
  }
  return [...jar.values()].join("; ");
}

/** Claude stream-json events for a reply streamed in `chunks` (init, text deltas, final result). */
export function claudeStream(chunks: string[], options: { result?: string; extra?: ProviderEvent[] } = {}): ProviderEvent[] {
  const event = (parsed: Record<string, unknown>): ProviderEvent => ({ timestamp: "", stream: "stdout", text: "", parsed });
  return [
    event({ type: "system", subtype: "init", tools: [], mcp_servers: [], model: "claude-test-model" }),
    ...chunks.map((text) => event({ type: "stream_event", event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } } })),
    ...(options.extra ?? []),
    event({ type: "result", result: options.result ?? chunks.join("").trim(), is_error: false }),
  ];
}

/** Parses an SSE body into [event, data] pairs. */
export async function sse(response: Response): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await response.text();
  return text.split("\n\n").filter(Boolean).map((block) => ({
    event: /^event: (.+)$/m.exec(block)?.[1] ?? "",
    data: JSON.parse(/^data: (.+)$/m.exec(block)?.[1] ?? "{}") as Record<string, unknown>,
  }));
}
