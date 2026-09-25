import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { HenryConfig } from "../config.ts";
import type { ActivityKind } from "../types.ts";
import { splitSentences, stripForSpeech } from "../voice/speakable.ts";
import { publicModeConfig, type PublicModeConfig } from "./config.ts";
import { PublishedPackCache } from "./pack.ts";
import { readPublicPersona } from "./persona.ts";
import { buildPublicPrompt } from "./prompt.ts";
import { guardPublicReply } from "./guard.ts";
import { publicStreamEvent, runPublicModelTurn, type PublicRunner } from "./turn.ts";
import { PublicReplyStream } from "./stream.ts";
import { publicTurnViolation } from "../providers/public-sandbox.ts";
import { EventSampler, maskContacts, type PublicLog } from "./log.ts";
import {
  ConcurrencyGate, RateLimiter, VisitorStore, detailsFromInput, isVisitorId, mergeDetails, newVisitorId,
  readVisitorCookie, visitorCookie, type Visitor,
} from "./visitors.ts";
import { OwnerPinger, type OwnerSend } from "./owner-ping.ts";
import { formatVisitNote, validateVisitorSummary, visitorLabel, visitorSummaryPrompt, VISITOR_NOTE_TAG } from "./notes.ts";

/**
 * HENRY'S PUBLIC FACE — everything an UNAUTHENTICATED visitor reaches through the Cloudflare tunnel.
 *
 * The dashboard server (src/dashboard/server.ts) classifies each request (isPublicRequest: any
 * Cloudflare/proxy header, a non-loopback Host, or a non-loopback peer). A tunnelled request
 * without the owner's session may reach only this file's explicit allowlist (PUBLIC_TUNNEL_ROUTES)
 * and the owner's login/logout (TUNNEL_LOGIN_ROUTES in server.ts); anything else is a 302 to
 * /login or a 401. Nothing on this surface reads memory, touches approvals or files, or reaches
 * another API. tests/public-routes.test.ts walks every route the server registers and asserts the
 * unauthenticated tunnel sees only these allowlists.
 *
 * Local requests (the owner on 127.0.0.1) may preview the same pages under /public/* and
 * /api/public/*; every other local path falls through to the owner's dashboard as before.
 */

/** Every method+path the tunnel may reach. `*` matches one path segment (VAD assets only). */
export const PUBLIC_TUNNEL_ROUTES: readonly string[] = Object.freeze([
  "GET /",
  "GET /public/chat",
  "GET /public/talk",
  "GET /public/manifest.webmanifest",
  "GET /public/icon.svg",
  "GET /vendor/vad/*",
  "GET /api/health",
  "GET /api/public/config",
  "GET /api/public/voice/greeting",
  "GET /api/public/voice/reprompt",
  "GET /api/public/voice/filler",
  "POST /api/public/chat",
  "POST /api/public/reset",
  "POST /api/public/ping",
  "POST /api/public/voice/transcribe",
  "POST /api/public/voice/speak",
  "POST /api/public/client-log",
]);

/**
 * Where the talk page loads Silero VAD from first: jsDelivr, pinned to the exact versions in
 * package-lock.json (verified byte-identical to node_modules), so a visitor's browser never pulls
 * ~16 MB through the owner's home upload. The page falls back to /vendor/vad/ when the CDN fails.
 * Only this origin is added to the public pages' CSP (script-src and connect-src).
 */
export const VAD_CDN_ORIGIN = "https://cdn.jsdelivr.net";

/** Events the public pages may report through POST /api/public/client-log (fixed set). */
export const CLIENT_LOG_EVENTS: readonly string[] = Object.freeze([
  "vad.ready", "vad.slow", "vad.cdn_failed", "vad.failed", "asset.error", "audio.error", "mic.denied", "stream.error",
]);
const CLIENT_LOG_DETAIL_MAX = 200;

/** The allowlist entry a request matches, or undefined. */
export function matchPublicRoute(method: string | undefined, pathname: string): string | undefined {
  const route = pathname.replace(/\/+$/, "") || "/";
  const key = `${method ?? "GET"} ${route}`;
  if (PUBLIC_TUNNEL_ROUTES.includes(key)) return key;
  if (method === "GET" && /^\/vendor\/vad\/[^/]+$/.test(route)) return "GET /vendor/vad/*";
  return undefined;
}

/** Paths the owner's local browser may use to preview the public face (everything else is the dashboard). */
export function isPublicPath(pathname: string): boolean {
  return pathname === "/public" || pathname.startsWith("/public/") || pathname === "/api/public" || pathname.startsWith("/api/public/");
}

const PROXY_HEADERS = ["cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "cdn-loop", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip"];
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

function hostName(hostHeader: string): string {
  const trimmed = hostHeader.trim().toLowerCase();
  if (trimmed.startsWith("[")) return trimmed.slice(0, trimmed.indexOf("]") + 1);
  const colon = trimmed.lastIndexOf(":");
  return colon === -1 ? trimmed : trimmed.slice(0, colon);
}

function peerIsLoopback(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress || "";
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || /^127\./.test(bare);
}

/**
 * FAIL-CLOSED classification: is this request (possibly) from the public internet? True when it
 * carries ANY Cloudflare or proxy header (the Cloudflare edge always adds CF-Connecting-IP and
 * CF-Ray, and a visitor cannot remove them), when its Host is not a loopback name, or when its
 * socket peer is not loopback. An attacker can only make a request look MORE public; the one way
 * to look local is to be the owner's own browser talking to 127.0.0.1. When the operator has
 * explicitly enabled the token-protected remote dashboard (non-loopback bind), the Host and peer
 * checks are skipped; proxy headers still route to the public face.
 */
export function isPublicRequest(request: http.IncomingMessage, options: { allowRemoteDashboard: boolean }): boolean {
  for (const header of PROXY_HEADERS) if (request.headers[header] !== undefined) return true;
  if (options.allowRemoteDashboard) return false;
  const host = request.headers.host;
  if (typeof host !== "string" || !LOOPBACK_HOSTS.has(hostName(host))) return true;
  return !peerIsLoopback(request);
}

/** Parses `value` as an https origin (`https://host[:port]`), or undefined. Exact-match material only. */
export function normalizeHttpsOrigin(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value.includes("://") ? value : `https://${value}`);
    if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * The https origins the public face trusts for its POSTs: HENRY_PUBLIC_ORIGIN, https://<HENRY_PUBLIC_HOST>,
 * and the live tunnel's reported URL. Exact string matches only: no suffix, no wildcard.
 */
export function trustedPublicOrigins(tunnelUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const origins = [normalizeHttpsOrigin(env.HENRY_PUBLIC_ORIGIN), normalizeHttpsOrigin(env.HENRY_PUBLIC_HOST), normalizeHttpsOrigin(tunnelUrl)]
    .filter((origin): origin is string => Boolean(origin));
  return [...new Set(origins)];
}

const LOOPBACK_ORIGIN_RE = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** A valid CF-Connecting-IP value (the edge sets it; it is only ever used as a rate-limit key). */
function cloudflareClientIp(request: http.IncomingMessage): string | undefined {
  const value = request.headers["cf-connecting-ip"];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return /^[0-9A-Fa-f:.]{3,45}$/.test(trimmed) ? trimmed : undefined;
}

/* ---------------------------------------------------------------- *
 * Visitor-facing lines (Henry's voice, nothing personal).
 * ---------------------------------------------------------------- */

export const PUBLIC_LINES = Object.freeze({
  busy: "I'm in a few conversations at once right now. Give me a minute, then ask me again?",
  rate: "You're quick! Give me a few seconds, then ask again.",
  oneAtATime: "Still answering your last question. One moment.",
  unavailable: "My public profile isn't published yet. Please check back soon.",
  failed: "Sorry, I couldn't answer that just now. Please try again in a moment.",
  tooLong: (max: number) => `That's a lot for one message. Could you keep it under ${max} characters?`,
  empty: "Ask me anything.",
});

export function defaultOpeningLine(ownerName: string): string {
  return `Hi, I'm Henry, ${ownerName}'s chief of staff and AI twin. Ask me anything about ${ownerName}'s work.`;
}

/* ---------------------------------------------------------------- *
 * The surface.
 * ---------------------------------------------------------------- */

export interface PublicVoice {
  sttEnabled(): boolean;
  ttsEnabled(): boolean;
  transcribe(audio: Buffer, options?: { language?: string; prompt?: string }): Promise<{ text: string; language?: string }>;
  synthesize(text: string, options?: { language?: string }): Promise<Buffer>;
}

export interface PublicSurfaceDeps {
  config: Pick<HenryConfig, "rootDir" | "dataDir" | "ownerName" | "telegramBotToken" | "telegramChatId" | "dashboardToken" | "allowRemoteDashboard">;
  activity: { record(kind: ActivityKind, message: string, metadata?: Record<string, unknown>): Promise<unknown> };
  memory: { remember(content: string, input?: { source?: string; tier?: string; importance?: number; metadata?: Record<string, unknown> }): Promise<string> };
  runner: PublicRunner;
  voice: PublicVoice;
  /** Cached synthesis of a fixed phrase (the dashboard's prompt cache). */
  synthesizeCached: (text: string) => Promise<Buffer>;
  fillers: readonly string[];
  vendorAsset: (name: string) => Promise<{ bytes: Buffer; contentType: string } | null>;
  /** Writes GET /api/health exactly as the local dashboard does. */
  health: (request: http.IncomingMessage, response: http.ServerResponse) => void;
  /** The live tunnel's public URL, when it reports one. */
  tunnelUrl: () => string | undefined;
  /** Whether the landing page's Owner button can sign in: ready, not set up yet, or switched off. */
  ownerAccess?: () => "ready" | "not-set-up" | "off";
  /** Owner-only Telegram (defaults to none: pings report unavailable). */
  send?: OwnerSend;
  /** The public request log (the server tracks each request; the surface annotates it). */
  log?: PublicLog;
  mode?: PublicModeConfig;
  now?: () => number;
  env?: NodeJS.ProcessEnv;
  /** Idle sweep period; 0 disables the timer (tests call sweepIdle()). */
  sweepIntervalMs?: number;
}

const PAGE_FILES = {
  landing: fileURLToPath(new URL("../dashboard/public-landing.html", import.meta.url)),
  chat: fileURLToPath(new URL("../dashboard/public-chat.html", import.meta.url)),
  talk: fileURLToPath(new URL("../dashboard/public-talk.html", import.meta.url)),
};
const pageCache = new Map<string, string>();
async function page(name: keyof typeof PAGE_FILES): Promise<string> {
  const cached = pageCache.get(name);
  if (cached) return cached;
  const html = await fs.readFile(PAGE_FILES[name], "utf8");
  pageCache.set(name, html);
  return html;
}

/** The public pages' CSP. Only the talk page (Silero VAD) may load from the pinned CDN origin. */
function publicCsp(allowVadCdn: boolean): string {
  const cdn = allowVadCdn ? ` ${VAD_CDN_ORIGIN}` : "";
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:${cdn}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self'${cdn}`,
    "worker-src 'self' blob:",
    "frame-ancestors 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "object-src 'none'",
  ].join("; ");
}
const PUBLIC_CSP = publicCsp(false);
const PUBLIC_TALK_CSP = publicCsp(true);

/**
 * /vendor/vad/* files are version-pinned by package-lock.json (a dependency bump changes what the
 * name serves only across a Henry restart, and the page asks for the same names), so a browser may
 * keep them for a year; repeat visits then load Silero without touching the tunnel.
 */
export const VENDOR_CACHE_CONTROL = "public, max-age=31536000, immutable";

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><defs><radialGradient id="g" cx="50%" cy="40%" r="60%"><stop offset="0" stop-color="#26e6ff"/><stop offset=".6" stop-color="#4e7dff"/><stop offset="1" stop-color="#07111f"/></radialGradient></defs><rect width="64" height="64" rx="14" fill="#07111f"/><circle cx="32" cy="32" r="22" fill="url(#g)"/><text x="32" y="40" text-anchor="middle" font-family="system-ui,sans-serif" font-size="22" font-weight="700" fill="#eef7ff">H</text></svg>`;

const MANIFEST = JSON.stringify({
  name: "Henry",
  short_name: "Henry",
  start_url: "/public/chat",
  scope: "/",
  display: "standalone",
  background_color: "#07111f",
  theme_color: "#07111f",
  icons: [{ src: "/public/icon.svg", sizes: "any", type: "image/svg+xml" }],
});

function securityHeaders(extra: http.OutgoingHttpHeaders = {}): http.OutgoingHttpHeaders {
  return {
    "x-content-type-options": "nosniff",
    "referrer-policy": "no-referrer",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    ...extra,
  };
}

function sendJson(response: http.ServerResponse, status: number, value: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(status, securityHeaders({ "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }));
  response.end(JSON.stringify(value));
}

async function readBody(request: http.IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > limit) throw Object.assign(new Error("too large"), { code: "too_large" });
    chunks.push(piece);
  }
  return Buffer.concat(chunks);
}

async function readJson(request: http.IncomingMessage, limit: number): Promise<Record<string, unknown>> {
  const raw = (await readBody(request, limit)).toString("utf8");
  const parsed: unknown = JSON.parse(raw || "{}");
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be a JSON object");
  return parsed as Record<string, unknown>;
}

/** Seconds of audio in a PCM WAV, or undefined when the header is unreadable. */
export function wavSeconds(audio: Buffer): number | undefined {
  try {
    let offset = 12; let byteRate = 0; let dataLength = 0;
    while (offset + 8 <= audio.length) {
      const name = audio.toString("ascii", offset, offset + 4);
      const size = audio.readUInt32LE(offset + 4);
      if (name === "fmt " && size >= 16) byteRate = audio.readUInt32LE(offset + 16);
      if (name === "data") { dataLength = Math.min(size, audio.length - offset - 8); break; }
      offset += 8 + size + (size & 1);
    }
    return byteRate > 0 && dataLength > 0 ? dataLength / byteRate : undefined;
  } catch { return undefined; }
}

export interface PublicSurface {
  /** Serves a public request. Always responds when `tunnelled`; otherwise returns false for non-public paths. */
  handle(request: http.IncomingMessage, response: http.ServerResponse, url: URL, tunnelled: boolean): Promise<boolean>;
  /** Closes idle visitor sessions (writes their notes). Returns how many were closed. */
  sweepIdle(): Promise<number>;
  /** Stops the sweep timer and writes notes for every open session (best effort). */
  close(): Promise<void>;
  readonly visitors: VisitorStore;
  readonly mode: PublicModeConfig;
}

export function createPublicSurface(deps: PublicSurfaceDeps): PublicSurface {
  const env = deps.env ?? process.env;
  const mode = deps.mode ?? publicModeConfig(deps.config, env);
  const now = deps.now ?? Date.now;
  const ownerName = deps.config.ownerName;
  const opening = mode.opening ?? defaultOpeningLine(ownerName);
  const reprompt = `Still there? Ask me anything about ${ownerName}.`;
  const pack = new PublishedPackCache(mode.packDir, mode.maxPackBytes, 15_000, now);
  const visitors = new VisitorStore({ maxHistoryTurns: mode.maxHistoryTurns, idleMs: mode.idleMs, maxVisitors: mode.maxVisitors }, now);
  const visitorLimiter = new RateLimiter([{ ms: 60_000, max: mode.perVisitorPerMinute }, { ms: 3_600_000, max: mode.perVisitorPerHour }], now);
  const clientLimiter = new RateLimiter([{ ms: 60_000, max: mode.perClientPerMinute }, { ms: 3_600_000, max: mode.perClientPerHour }], now);
  const audioLimiter = new RateLimiter([{ ms: 60_000, max: mode.perClientPerMinute * 2 }, { ms: 3_600_000, max: mode.perClientPerHour * 2 }], now);
  const gate = new ConcurrencyGate(mode.maxConcurrent, mode.maxQueue);
  const pinger = new OwnerPinger(deps.send, { ownerName, noticeIntervalMs: mode.noticeIntervalMs, pingsPerHour: mode.pingsPerHour }, now);
  const blockedValues = [deps.config.telegramBotToken, deps.config.telegramChatId, deps.config.dashboardToken, env.HENRY_DASH_SECRET, env.HENRY_KOKORO_TOKEN];
  let sttBusy = false;
  let ttsBusy = false;

  const record = (kind: ActivityKind, message: string, metadata: Record<string, unknown> = {}): void => {
    void deps.activity.record(kind, message, { public: true, ...metadata }).catch(() => undefined);
  };
  // Refusals and page-reported errors can arrive in bursts: the journal gets the first of each
  // kind per minute plus a count of the ones folded into it (the request log keeps every one).
  const sampler = new EventSampler(60_000, now);
  const recordSampled = (key: string, kind: ActivityKind, message: string, metadata: Record<string, unknown> = {}): void => {
    const suppressed = sampler.take(key);
    if (suppressed === undefined) return;
    record(kind, message, { ...metadata, ...(suppressed ? { suppressedSinceLast: suppressed } : {}) });
  };
  const refuse = (reason: string, message: string): void => recordSampled(`refused:${reason}`, "public.refused", message, { reason });
  const note = (response: http.ServerResponse, fields: Parameters<PublicLog["annotate"]>[1]): void => deps.log?.annotate(response, fields);

  const clientKey = (request: http.IncomingMessage, tunnelled: boolean): string => {
    // CF-Connecting-IP only when the request came through the tunnel, and only for rate limits.
    const ip = tunnelled ? cloudflareClientIp(request) : undefined;
    return ip ? `cf:${ip}` : `peer:${request.socket.remoteAddress ?? "unknown"}`;
  };

  const originOk = (request: http.IncomingMessage, tunnelled: boolean): boolean => {
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !origin) return false;
    const trusted = trustedPublicOrigins(deps.tunnelUrl(), env);
    if (tunnelled) return trusted.includes(origin);
    return LOOPBACK_ORIGIN_RE.test(origin) || trusted.includes(origin);
  };

  /** The visitor id from the cookie, minting (and setting) a new one when absent. */
  const visitorIdFor = (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean): string => {
    const existing = readVisitorCookie(request.headers.cookie);
    if (existing) return existing;
    const id = newVisitorId();
    response.setHeader("set-cookie", visitorCookie(id, tunnelled));
    return id;
  };

  const finalizeVisitor = async (visitor: Visitor, summarise: boolean): Promise<void> => {
    if (!visitor.questions.length) return;
    let summary;
    if (summarise && mode.summarise && gate.free) {
      const release = await gate.acquire(0);
      if (release) {
        try {
          const turn = await runPublicModelTurn(deps.runner, mode, visitorSummaryPrompt(visitor), { tier: "t0", role: "public-summary", model: null });
          summary = turn.error ? undefined : validateVisitorSummary(turn.reply);
        } catch { /* a failed summary just leaves the heuristic details */ } finally { release(); }
      }
    }
    const date = new Date(visitor.createdAt).toISOString().slice(0, 10);
    try {
      await deps.memory.remember(formatVisitNote(visitor, { ownerName, summary, now: new Date(now()) }), {
        source: `visitors/${date}-${visitorLabel(visitor)}.md`,
        tier: "episodic",
        importance: visitor.pinged ? 7 : 5,
        metadata: { kind: VISITOR_NOTE_TAG, tag: VISITOR_NOTE_TAG, untrusted: true, turns: visitor.turns, pinged: visitor.pinged },
      });
      record("public.note", "Public visitor note saved", { turns: visitor.turns, pinged: visitor.pinged, summarised: Boolean(summary) });
    } catch (error) {
      record("public.note", "Public visitor note could not be saved", { error: error instanceof Error ? error.message : String(error) });
    }
  };

  const sweepIdle = async (): Promise<number> => {
    const idle = visitors.takeIdle();
    for (const visitor of idle) await finalizeVisitor(visitor, true);
    return idle.length;
  };
  const sweepMs = deps.sweepIntervalMs ?? 60_000;
  const sweepTimer = sweepMs > 0 ? setInterval(() => { void sweepIdle().catch(() => undefined); }, sweepMs) : undefined;
  sweepTimer?.unref?.();

  const servePage = async (response: http.ServerResponse, name: keyof typeof PAGE_FILES): Promise<void> => {
    response.writeHead(200, securityHeaders({
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": name === "talk" ? PUBLIC_TALK_CSP : PUBLIC_CSP,
      "permissions-policy": name === "talk" ? "microphone=(self), camera=(), geolocation=()" : "microphone=(), camera=(), geolocation=()",
    }));
    response.end(await page(name));
  };

  /* ---------------- POST /api/public/chat ---------------- */
  const chat = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean, visitorId: string): Promise<void> => {
    let input: Record<string, unknown>;
    try { input = await readJson(request, 16_384); } catch { sendJson(response, 400, { error: "Send a JSON body with a message." }); return; }
    const message = typeof input.message === "string" ? input.message.trim() : "";
    const voiceTurn = input.voice === true;
    note(response, { voice: voiceTurn });
    if (!message) { sendJson(response, 400, { error: PUBLIC_LINES.empty }); return; }
    if (message.length > mode.maxMessageChars) { sendJson(response, 413, { error: PUBLIC_LINES.tooLong(mode.maxMessageChars) }); return; }
    if (visitors.get(visitorId)?.busy) { note(response, { busy: true }); sendJson(response, 429, { error: PUBLIC_LINES.oneAtATime }); return; }
    if (!clientLimiter.take(clientKey(request, tunnelled)) || !visitorLimiter.take(visitorId)) {
      refuse("rate", "Public chat rate-limited");
      note(response, { rateLimited: true });
      sendJson(response, 429, { error: PUBLIC_LINES.rate });
      return;
    }
    // Claimed synchronously (no await since the check above), so two racing requests from one
    // visitor can never both start a model turn.
    const { visitor, created, evicted } = visitors.ensure(visitorId);
    if (visitor.busy) { note(response, { busy: true }); sendJson(response, 429, { error: PUBLIC_LINES.oneAtATime }); return; }
    visitor.busy = true;
    const packState = await pack.get();
    if (!packState.ok) {
      visitor.busy = false;
      note(response, { failed: "unpublished" });
      sendJson(response, 503, { error: PUBLIC_LINES.unavailable });
      return;
    }
    if (evicted) void finalizeVisitor(evicted, false);
    if (created) record("public.visitor", "A new public visitor started a conversation", { channel: voiceTurn ? "voice" : "chat" });
    visitor.channels.add(voiceTurn ? "voice" : "chat");
    const firstQuestion = visitor.questions.length === 0;
    visitors.recordQuestion(visitor, message);
    if (firstQuestion) void pinger.noticeNewVisitor(visitor, message, voiceTurn ? "voice" : "chat");

    response.writeHead(200, securityHeaders({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", connection: "keep-alive" }));
    const write = (event: string, data: unknown): void => { if (!response.writableEnded) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); };
    let release: (() => void) | null = null;
    const started = now();
    let firstSentMs: number | null = null;
    let segmentsSent = 0;
    // Streamed sentences. A voice turn gets an id per sentence so the talk page can start speaking
    // the first one at once; the first sentence of a reply pays the speech rate limit, the rest
    // ride on it (once each).
    const sendPiece = (text: string): void => {
      if (firstSentMs === null) firstSentMs = now() - started;
      let segmentId: string | undefined;
      if (voiceTurn) {
        segmentId = crypto.randomBytes(9).toString("base64url");
        visitors.recordSegment(visitor, segmentId, text, segmentsSent > 0);
      }
      segmentsSent += 1;
      write("token", { text, ...(segmentId ? { replyId: segmentId } : {}) });
    };
    const stream = new PublicReplyStream(ownerName, blockedValues, (output) => {
      if (output.type === "reset") { write("reset", {}); return; }
      sendPiece(output.text);
    });
    try {
      write("status", { state: "thinking" });
      release = await gate.acquire(mode.queueWaitMs, () => {
        write("status", { state: "queued" });
        if (voiceTurn) write("gathering", { reason: "request" });
      });
      const queueMs = now() - started;
      if (!release) {
        refuse("busy", "Public chat refused: every model slot is busy");
        note(response, { busy: true, queueMs });
        write("error", { error: PUBLIC_LINES.busy, busy: true });
        return;
      }
      const persona = await readPublicPersona(deps.config.rootDir, ownerName);
      const prompt = buildPublicPrompt({ ownerName, persona, pack: packState.text, history: visitor.history, message, voice: voiceTurn });
      const turn = await runPublicModelTurn(deps.runner, mode, prompt, {
        onEvent: (event) => {
          // The violation rail, live: the runner discards such an answer when the run ends, but
          // the visitor may already hold streamed sentences, so they are withdrawn at once. A
          // Claude event never looks like a Codex item and vice versa, so both checks are safe.
          const violation = publicTurnViolation("claude", [event]) ?? publicTurnViolation("codex", [event]);
          if (violation) { stream.halt(violation); return; }
          const streamed = publicStreamEvent(event);
          if (!streamed) return;
          if (streamed.kind === "start") stream.start();
          else stream.push(streamed.text);
        },
      });
      const timings = { provider: turn.provider, model: turn.model, firstTextMs: turn.firstTextMs ?? null, firstSentMs, totalMs: now() - started, queueMs };
      if (turn.error || !turn.reply) {
        const failure = turn.timedOut ? "timeout" : turn.limited ? "limited" : /sandbox violation/.test(turn.error ?? "") ? "violation" : turn.error ? "error" : "empty";
        record("public.turn", turn.timedOut ? "Public turn timed out" : "Public turn failed", {
          provider: turn.provider, durationMs: turn.durationMs, error: (turn.error ?? "empty reply").slice(0, 200), limited: turn.limited === true, failure,
        });
        note(response, { ...timings, failed: failure, streamed: segmentsSent });
        // Anything streamed from a discarded answer (e.g. a tool call surfaced late) is withdrawn.
        if (stream.streamed) write("reset", {});
        write("error", { error: PUBLIC_LINES.failed });
        return;
      }
      const guarded = guardPublicReply(turn.reply, ownerName, blockedValues);
      if (!guarded.ok) record("public.refused", "Public reply blocked by the output guard", { reason: guarded.reason, midStream: stream.tripped });
      const finish = stream.finish(guarded);
      const replyId = crypto.randomBytes(9).toString("base64url");
      visitors.recordExchange(visitor, message, guarded.text, replyId);
      if (finish.action === "append") for (const piece of finish.pieces) sendPiece(piece);
      else write("replace", { text: guarded.text });
      record("public.turn", "Public turn answered", {
        provider: turn.provider, model: turn.model ?? null, durationMs: turn.durationMs, firstTextMs: turn.firstTextMs ?? null, firstSentMs,
        chars: guarded.text.length, voice: voiceTurn, blocked: !guarded.ok, streamed: segmentsSent, replaced: finish.action === "replace",
      });
      note(response, { ...timings, totalMs: now() - started, blocked: !guarded.ok, streamed: segmentsSent, replaced: finish.action === "replace" });
      // `streamed`: the token events already carried the whole reply, in order (the talk page has
      // queued their speech); otherwise the page shows/speaks this reply by its id.
      write("done", { response: guarded.text, replyId, streamed: finish.action === "append", ...(voiceTurn ? { spoken: stripForSpeech(guarded.text) } : {}) });
    } catch (error) {
      record("public.turn", "Public turn threw", { error: (error instanceof Error ? error.message : String(error)).slice(0, 200), failure: "threw" });
      note(response, { failed: "threw", totalMs: now() - started });
      if (stream.streamed) write("reset", {});
      write("error", { error: PUBLIC_LINES.failed });
    } finally {
      release?.();
      visitor.busy = false;
      visitor.lastSeen = now();
      response.end();
    }
  };

  /* ---------------- POST /api/public/ping ---------------- */
  const ping = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean, visitorId: string): Promise<void> => {
    let input: Record<string, unknown>;
    try { input = await readJson(request, 8_192); } catch { sendJson(response, 400, { error: "Send a JSON body." }); return; }
    if (!clientLimiter.take(clientKey(request, tunnelled))) { sendJson(response, 429, { error: PUBLIC_LINES.rate }); return; }
    const { visitor, created } = visitors.ensure(visitorId);
    if (created) record("public.visitor", "A new public visitor opened the ping form", { channel: "ping" });
    const typed = detailsFromInput(input);
    // What the visitor typed into the form wins; the chat heuristics fill the gaps.
    const details = { ...typed, ...(typed.contact ? { contact: [...typed.contact] } : {}) };
    mergeDetails(details, visitor.details);
    mergeDetails(visitor.details, typed);
    if (typed.message) visitors.recordQuestion(visitor, `[ping message] ${typed.message}`);
    const outcome = await pinger.ping(visitor, details);
    record("public.ping", outcome.ok ? "Visitor pinged the owner" : `Visitor ping not sent (${outcome.reason})`, { ok: outcome.ok, ...(outcome.ok ? {} : { reason: outcome.reason }) });
    if (outcome.ok) { sendJson(response, 200, { ok: true, message: `Done. ${ownerName} has your details and will reach out if it's a fit.` }); return; }
    const messages: Record<string, [number, string]> = {
      already: [409, `Already sent. ${ownerName} has your details.`],
      cap: [429, `I've passed on a lot of notes this hour. Please try again a bit later, or keep chatting with me.`],
      unavailable: [503, `I can't reach ${ownerName} from here right now, but I've noted your details.`],
      failed: [502, `I couldn't reach ${ownerName} just now. Please try again in a minute.`],
    };
    const [status, message] = messages[outcome.reason];
    sendJson(response, status, { ok: false, error: message });
  };

  /* ---------------- voice ---------------- */
  const transcribe = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean): Promise<void> => {
    if (!deps.voice.sttEnabled()) { sendJson(response, 503, { error: "Voice isn't available right now. You can type instead." }); return; }
    const mime = (request.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
    if (mime !== "audio/wav" && mime !== "audio/x-wav") { sendJson(response, 415, { error: "Send audio/wav." }); return; }
    const declared = Number(request.headers["content-length"] || 0);
    if (declared > mode.maxAudioBytes) { sendJson(response, 413, { error: "That recording is too long. Try a shorter question." }); return; }
    if (!audioLimiter.take(clientKey(request, tunnelled))) {
      refuse("audio-rate", "Public transcription rate-limited");
      note(response, { rateLimited: true });
      sendJson(response, 429, { error: PUBLIC_LINES.rate });
      return;
    }
    if (sttBusy) { note(response, { busy: true }); sendJson(response, 429, { error: "I'm listening to someone else for a second. Try again." }); return; }
    sttBusy = true;
    const sttStarted = now();
    try {
      let audio: Buffer;
      try { audio = await readBody(request, mode.maxAudioBytes); } catch { sendJson(response, 413, { error: "That recording is too long. Try a shorter question." }); return; }
      if (audio.length < 44 || audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE") { sendJson(response, 400, { error: "Audio must be a WAV file." }); return; }
      const seconds = wavSeconds(audio);
      if (seconds === undefined) { sendJson(response, 400, { error: "Audio must be a PCM WAV file." }); return; }
      if (seconds > mode.maxAudioSeconds) { sendJson(response, 413, { error: "That recording is too long. Try a shorter question." }); return; }
      // Nothing is stored: no transcript row, no audio file. The words reach Henry only when the
      // page sends them as the next chat message.
      const result = await deps.voice.transcribe(audio, { language: "auto", prompt: `A visitor talking to Henry about ${ownerName}.` });
      note(response, { sttMs: now() - sttStarted, audioMs: Math.round(seconds * 1000) });
      sendJson(response, 200, { text: result.text.trim().slice(0, mode.maxMessageChars) });
    } catch {
      note(response, { sttMs: now() - sttStarted, failed: "stt" });
      if (!response.headersSent) sendJson(response, 503, { error: "I didn't catch that. Could you try again?" });
    } finally { sttBusy = false; }
  };

  const speak = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean, visitorId: string): Promise<void> => {
    if (!deps.voice.ttsEnabled()) { sendJson(response, 503, { error: "Speech is unavailable." }); return; }
    let input: Record<string, unknown>;
    try { input = await readJson(request, 2_048); } catch { sendJson(response, 400, { error: "Send a JSON body." }); return; }
    // Only a reply Henry actually gave THIS visitor can be spoken: the endpoint is not a
    // general text-to-speech service.
    const replyId = typeof input.replyId === "string" ? input.replyId : "";
    const owner = visitors.get(visitorId);
    const segment = replyId ? owner?.segments.get(replyId) : undefined;
    const text = (replyId ? owner?.replies.get(replyId) : undefined) ?? segment?.text;
    if (!text) { sendJson(response, 404, { error: "Nothing to say." }); return; }
    if (ttsBusy) { note(response, { busy: true }); sendJson(response, 429, { error: "One moment." }); return; }
    // A follow-on sentence of a streamed reply is free once (its first sentence paid).
    const free = segment?.free === true;
    if (free) segment.free = false;
    if (!free && !audioLimiter.take(clientKey(request, tunnelled))) {
      refuse("speech-rate", "Public speech rate-limited");
      note(response, { rateLimited: true });
      sendJson(response, 429, { error: PUBLIC_LINES.rate });
      return;
    }
    ttsBusy = true;
    const ttsStarted = now();
    try {
      const spoken = stripForSpeech(text) || text;
      const pieces = splitSentences(spoken);
      response.writeHead(200, securityHeaders({ "content-type": "application/x-henry-wav-seq", "cache-control": "no-store" }));
      for (const piece of pieces.length ? pieces : [spoken]) {
        if (response.destroyed) break;
        const audio = await deps.voice.synthesize(piece, { language: "en" });
        const prefix = Buffer.alloc(4);
        prefix.writeUInt32BE(audio.length, 0);
        response.write(prefix);
        response.write(audio);
      }
      note(response, { ttsMs: now() - ttsStarted, segment: Boolean(segment) });
      response.end();
    } catch {
      note(response, { ttsMs: now() - ttsStarted, failed: "tts" });
      if (response.headersSent) { if (!response.writableEnded) response.end(); }
      else sendJson(response, 503, { error: "Speech is unavailable." });
    } finally { ttsBusy = false; }
  };

  /* ---------------- POST /api/public/client-log ----------------
     The pages report asset/VAD/audio trouble here so the owner can see why a visitor's talk page
     misbehaved. Fixed schema: {event: one of CLIENT_LOG_EVENTS, detail: <=200 printable chars}.
     Rate-limited per client; the detail is visitor-controlled DATA, logged, never interpreted. */
  const clientLogLimiter = new RateLimiter([{ ms: 60_000, max: 10 }, { ms: 3_600_000, max: 60 }], now);
  const clientLog = async (request: http.IncomingMessage, response: http.ServerResponse, tunnelled: boolean): Promise<void> => {
    let input: Record<string, unknown>;
    try { input = await readJson(request, 1_024); } catch { sendJson(response, 400, { error: "Send a JSON body." }); return; }
    const event = typeof input.event === "string" ? input.event : "";
    if (!CLIENT_LOG_EVENTS.includes(event)) { sendJson(response, 400, { error: "unknown event" }); return; }
    const extra = Object.keys(input).filter((key) => key !== "event" && key !== "detail");
    if (extra.length || (input.detail !== undefined && typeof input.detail !== "string")) { sendJson(response, 400, { error: "send {event, detail}" }); return; }
    if (!clientLogLimiter.take(clientKey(request, tunnelled))) { note(response, { rateLimited: true }); sendJson(response, 429, { error: "slow down" }); return; }
    const detail = typeof input.detail === "string" ? maskContacts(input.detail.slice(0, 1_000).replace(/[^\x20-\x7e]/g, " ").replace(/\s+/g, " ").trim()).slice(0, CLIENT_LOG_DETAIL_MAX) : "";
    note(response, { event, ...(detail ? { detail } : {}) });
    if (event !== "vad.ready") recordSampled(`client:${event}`, "public.client", `Public page reported ${event}`, { event, detail });
    sendJson(response, 200, { ok: true });
  };

  const phrase = async (response: http.ServerResponse, text: string): Promise<void> => {
    if (!deps.voice.ttsEnabled()) { sendJson(response, 404, { error: "Speech is unavailable." }); return; }
    try {
      const audio = await deps.synthesizeCached(text);
      response.writeHead(200, securityHeaders({ "content-type": "audio/wav", "content-length": audio.length, "cache-control": "private, max-age=3600" }));
      response.end(audio);
    } catch {
      sendJson(response, 503, { error: "Speech is unavailable." });
    }
  };

  const handle = async (request: http.IncomingMessage, response: http.ServerResponse, url: URL, tunnelled: boolean): Promise<boolean> => {
    const route = matchPublicRoute(request.method, url.pathname);
    if (!tunnelled) {
      // Local: only /public/* and /api/public/* belong to this surface; "/", /api/health and
      // /vendor/vad/* stay the owner's dashboard routes.
      if (!isPublicPath(url.pathname)) return false;
      if (!route || route === "GET /") { sendJson(response, 404, { error: "not found" }); return true; }
    }
    if (!route) { sendJson(response, 404, { error: "not found" }); return true; }
    const existingVisitor = readVisitorCookie(request.headers.cookie);
    note(response, { route, ...(isVisitorId(existingVisitor) ? { visitor: deps.log?.visitorHash(existingVisitor) } : {}) });
    try {
      if (route === "GET /api/health") { deps.health(request, response); return true; }
      if (route === "GET /vendor/vad/*") {
        let name = "";
        try { name = decodeURIComponent(url.pathname.slice("/vendor/vad/".length).replace(/\/+$/, "")); } catch { /* not on the allowlist */ }
        const asset = name ? await deps.vendorAsset(name) : null;
        if (!asset) { sendJson(response, 404, { error: "not found" }); return true; }
        response.writeHead(200, securityHeaders({ "content-type": asset.contentType, "content-length": asset.bytes.length, "cache-control": VENDOR_CACHE_CONTROL }));
        response.end(asset.bytes);
        return true;
      }
      if (route === "GET /public/manifest.webmanifest") {
        response.writeHead(200, securityHeaders({ "content-type": "application/manifest+json; charset=utf-8", "cache-control": "public, max-age=3600" }));
        response.end(MANIFEST);
        return true;
      }
      if (route === "GET /public/icon.svg") {
        response.writeHead(200, securityHeaders({ "content-type": "image/svg+xml", "cache-control": "public, max-age=86400", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" }));
        response.end(ICON_SVG);
        return true;
      }
      if (route === "GET /" || route === "GET /public/chat" || route === "GET /public/talk") {
        // The cookie is set with the page, so the first API call already carries it.
        const pageVisitor = visitorIdFor(request, response, tunnelled);
        note(response, { visitor: deps.log?.visitorHash(pageVisitor) });
        // "/" is the landing page (recruiter or owner); the faces live under /public/.
        await servePage(response, route === "GET /" ? "landing" : route === "GET /public/talk" ? "talk" : "chat");
        return true;
      }
      if (route === "GET /api/public/config") {
        const packState = await pack.get();
        sendJson(response, 200, {
          ownerName, opening, available: packState.ok,
          voice: { stt: deps.voice.sttEnabled(), tts: deps.voice.ttsEnabled() },
          maxMessageChars: mode.maxMessageChars,
          ping: pinger.available,
          ownerAccess: deps.ownerAccess?.() ?? "off",
        });
        return true;
      }
      if (route === "GET /api/public/voice/greeting") { await phrase(response, opening); return true; }
      if (route === "GET /api/public/voice/reprompt") { await phrase(response, reprompt); return true; }
      if (route === "GET /api/public/voice/filler") {
        const fillers = deps.fillers.length ? deps.fillers : ["One moment."];
        const variant = Math.max(0, Math.min(99, Number.parseInt(url.searchParams.get("v") ?? "0", 10) || 0));
        await phrase(response, fillers[variant % fillers.length]);
        return true;
      }
      // Every POST: exact trusted origin (loopback too for the owner's local preview) and a cookie.
      if (!originOk(request, tunnelled)) { sendJson(response, 403, { error: "cross-origin request rejected" }); return true; }
      const cookieId = readVisitorCookie(request.headers.cookie);
      const visitorId = isVisitorId(cookieId) ? cookieId : visitorIdFor(request, response, tunnelled);
      note(response, { visitor: deps.log?.visitorHash(visitorId) });
      if (route === "POST /api/public/chat") { await chat(request, response, tunnelled, visitorId); return true; }
      if (route === "POST /api/public/ping") { await ping(request, response, tunnelled, visitorId); return true; }
      if (route === "POST /api/public/reset") {
        const visitor = visitors.get(visitorId);
        if (visitor && !visitor.busy) visitors.resetConversation(visitor);
        sendJson(response, 200, { ok: true });
        return true;
      }
      if (route === "POST /api/public/voice/transcribe") { await transcribe(request, response, tunnelled); return true; }
      if (route === "POST /api/public/voice/speak") { await speak(request, response, tunnelled, visitorId); return true; }
      if (route === "POST /api/public/client-log") { await clientLog(request, response, tunnelled); return true; }
      sendJson(response, 404, { error: "not found" });
      return true;
    } catch {
      if (response.headersSent) { if (!response.writableEnded) response.end(); }
      else sendJson(response, 500, { error: PUBLIC_LINES.failed });
      return true;
    }
  };

  return {
    handle,
    sweepIdle,
    async close() {
      if (sweepTimer) clearInterval(sweepTimer);
      for (const visitor of visitors.takeAll()) await finalizeVisitor(visitor, false);
    },
    visitors,
    mode,
  };
}
