import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DASHBOARD_HTML } from "./page.ts";
import { clearedSessionCookie, endSession, issueSession, readSession, requireRole, verifyLogin, type Role, type SessionUser } from "./auth.ts";
import { KnowledgeBase } from "../knowledge/store.ts";
import { sampleResources } from "./resources.ts";
import { sharedAdmissionController } from "../orchestration/admission.ts";
import { domainPolicy, setDomainEnabled } from "../knowledge/gate.ts";
import type { HenryRuntime } from "../runtime.ts";
import type { ActivityEvent, ProviderName } from "../types.ts";

const EVENTS_POLL_MS = 2000;

function sseWrite(response: http.ServerResponse, event: string, data: unknown): void {
  if (response.writableEnded) return;
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Lazily constructed and cached: constructing KnowledgeBase is cheap (the local
// embedding model is lazy-loaded on first `embed()` call, not on construction —
// see src/embeddings.ts), but `engine.stats()` runs several synchronous
// better-sqlite3 queries (COUNT/GROUP BY over the whole table) that measured
// ~300-400ms cold on a ~19k-row knowledge.db and ~1-2ms once the SQLite page
// cache is warm. better-sqlite3 is synchronous, so that first call blocks the
// whole Node event loop — starving every other in-flight request (including
// /api/status and the SSE handshake) for its duration. To keep /api/knowledge
// off the hot path we never do this work inline on a request: the first
// request kicks off construction+stats() in the background via setImmediate
// (so it runs after the current response is flushed) and replies
// {loading:true} immediately; once the background job finishes, the computed
// stats are cached and every subsequent request (including later polls of the
// same loading request) returns them instantly.
let knowledgeBaseCache: KnowledgeBase | null = null;
let knowledgeStatsCache: Record<string, unknown> | null = null;
let knowledgeStatsError: string | null = null;
let knowledgeInitStarted = false;

function startKnowledgeInit(runtime: HenryRuntime): void {
  if (knowledgeInitStarted) return;
  knowledgeInitStarted = true;
  setImmediate(() => {
    try {
      knowledgeBaseCache ||= new KnowledgeBase(runtime.config);
      knowledgeStatsCache = knowledgeBaseCache.stats();
      knowledgeStatsError = null;
    } catch (error) {
      knowledgeStatsError = error instanceof Error ? error.message : String(error);
    } finally {
      // Allow a later retry (e.g. db appeared after a failed access check).
      if (knowledgeStatsError) knowledgeInitStarted = false;
    }
  });
}

// Distillation progress (dashboard-design-v2.md §B3): knowledge/cards/.distilled.json
// lists already-distilled module keys; knowledge/raw/chunks.jsonl's distinct
// module_id values are the population that could be distilled (mirrors, read-only,
// the pending-set src/knowledge/ingest.ts#distillCards derives from — this file never
// writes to either path). chunks.jsonl runs ~12MB/5k lines, so — same reasoning as
// the knowledge-stats cache above — it is read once in the background via
// setImmediate and cached rather than inline on a request.
let distillationCache: { distilled: number; totalModules: number } | null = null;
let distillationError: string | null = null;
let distillationInitStarted = false;

function startDistillationInit(runtime: HenryRuntime): void {
  if (distillationInitStarted) return;
  distillationInitStarted = true;
  setImmediate(async () => {
    try {
      const cardsDir = path.join(runtime.config.knowledgeDir, "cards");
      const rawDir = path.join(runtime.config.knowledgeDir, "raw");
      const distilledRaw = await fs.readFile(path.join(cardsDir, ".distilled.json"), "utf8");
      const distilledIds: unknown = JSON.parse(distilledRaw);
      const distilled = Array.isArray(distilledIds) ? distilledIds.length : 0;
      const chunksRaw = await fs.readFile(path.join(rawDir, "chunks.jsonl"), "utf8");
      const modules = new Set<string>();
      const moduleIdPattern = /"module_id"\s*:\s*"([^"]*)"/;
      for (const line of chunksRaw.split("\n")) {
        const match = moduleIdPattern.exec(line);
        if (match?.[1]) modules.add(match[1]);
      }
      distillationCache = { distilled, totalModules: modules.size };
      distillationError = null;
    } catch (error) {
      distillationError = error instanceof Error ? error.message : String(error);
    } finally {
      if (distillationError) distillationInitStarted = false;
    }
  });
}

// The Memory Observatory is a ~2k-line designer-authored page. It is served
// from disk rather than embedded in page.ts's template literal: that literal
// already produced a page-killing escaping bug once, and a standalone .html
// keeps backticks/${...}/backslashes in the designer's markup harmless. Read
// once, then cached for the process lifetime (the file never changes at run
// time); a read failure is not cached, so a fixed file recovers on next hit.
const OBSERVATORY_HTML_PATH = fileURLToPath(new URL("./observatory.html", import.meta.url));
let observatoryHtmlCache: string | null = null;

async function observatoryHtml(): Promise<string> {
  observatoryHtmlCache ??= await fs.readFile(OBSERVATORY_HTML_PATH, "utf8");
  return observatoryHtmlCache;
}

const LOGS_HTML_PATH = fileURLToPath(new URL("./logs.html", import.meta.url));
let logsHtmlCache: string | null = null;
async function logsHtml(): Promise<string> {
  logsHtmlCache ??= await fs.readFile(LOGS_HTML_PATH, "utf8");
  return logsHtmlCache;
}

// The chat page ships as a standalone .html for the same escaping-safety reason
// as the observatory above.
const CHAT_HTML_PATH = fileURLToPath(new URL("./chat.html", import.meta.url));
let chatHtmlCache: string | null = null;

async function chatHtml(): Promise<string> {
  chatHtmlCache ??= await fs.readFile(CHAT_HTML_PATH, "utf8");
  return chatHtmlCache;
}

const KNOWLEDGE_ADMIN_HTML_PATH = fileURLToPath(new URL("./knowledge-admin.html", import.meta.url));
let knowledgeAdminHtmlCache: string | null = null;
async function knowledgeAdminHtml(): Promise<string> {
  knowledgeAdminHtmlCache ??= await fs.readFile(KNOWLEDGE_ADMIN_HTML_PATH, "utf8");
  return knowledgeAdminHtmlCache;
}

const LOGIN_HTML_PATH = fileURLToPath(new URL("./login.html", import.meta.url));
let loginHtmlCache: string | null = null;
async function loginHtml(): Promise<string> {
  loginHtmlCache ??= await fs.readFile(LOGIN_HTML_PATH, "utf8");
  return loginHtmlCache;
}

/**
 * Web-chat transcript (data/chats/web-chat.json) — the page reloads it on open, so a
 * conversation survives refreshes and browser switches. Provider-side context lives
 * separately in the "web-chat" surface session (sessions.db); this file is only the
 * human-readable half. Re-read before every write (reminders-clobber lesson) and
 * capped so it never grows unbounded.
 */
const CHAT_TRANSCRIPT_CAP = 400;
interface ChatMessage { role: "user" | "henry"; text: string; at: string }

function chatTranscriptPath(runtime: HenryRuntime): string {
  return path.join(runtime.config.dataDir, "chats", "web-chat.json");
}

async function readChatTranscript(runtime: HenryRuntime): Promise<ChatMessage[]> {
  try {
    const raw = JSON.parse(await fs.readFile(chatTranscriptPath(runtime), "utf8")) as { messages?: unknown };
    if (!Array.isArray(raw.messages)) return [];
    return raw.messages.filter((item): item is ChatMessage =>
      !!item && typeof item === "object"
      && ((item as ChatMessage).role === "user" || (item as ChatMessage).role === "henry")
      && typeof (item as ChatMessage).text === "string");
  } catch { return []; }
}

// All transcript mutations run through one module-level chain (audit M4): append
// is read-then-write, so two overlapping sends could each read the same base and
// the second write would drop the first send's reply. The generation counter
// closes the race's other half: a send that finishes AFTER "New chat" cleared the
// transcript must not resurrect its stale reply into the fresh conversation — the
// send handler records the generation up front, and its final append is skipped
// (inside the lock) once a clear has bumped it.
let chatWriteChain: Promise<void> = Promise.resolve();
let chatClearGeneration = 0;

function withChatTranscript<T>(operation: () => Promise<T>): Promise<T> {
  const run = chatWriteChain.then(operation);
  chatWriteChain = run.then(() => undefined, () => undefined);
  return run;
}

async function appendChatMessages(runtime: HenryRuntime, entries: ChatMessage[], options: { ifGeneration?: number } = {}): Promise<void> {
  await withChatTranscript(async () => {
    if (options.ifGeneration !== undefined && options.ifGeneration !== chatClearGeneration) return; // cleared mid-run — drop, never resurrect
    const filePath = chatTranscriptPath(runtime);
    await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
    const fresh = await readChatTranscript(runtime);
    const messages = [...fresh, ...entries].slice(-CHAT_TRANSCRIPT_CAP);
    await fs.writeFile(filePath, `${JSON.stringify({ messages }, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  });
}

async function clearChatTranscript(runtime: HenryRuntime): Promise<void> {
  await withChatTranscript(async () => {
    chatClearGeneration += 1;
    await fs.rm(chatTranscriptPath(runtime), { force: true });
  });
}

// The holographic memory display is hand-rolled 3D canvas code. Same reasoning
// as the observatory above: it ships as a plain .js asset instead of living
// inside page.ts's template literal, where backticks/${...}/backslashes would
// be a live escaping hazard. Cached for the process lifetime; failures are not
// cached so a fixed file recovers on the next request.
const HOLO_JS_PATH = fileURLToPath(new URL("./holo.js", import.meta.url));
let holoJsCache: string | null = null;

async function holoJs(): Promise<string> {
  holoJsCache ??= await fs.readFile(HOLO_JS_PATH, "utf8");
  return holoJsCache;
}

// GET /api/engram/metrics wraps src/metrics/recall-metrics.ts#summarizeRecallMetrics —
// a module owned elsewhere (dashboard-design-v2.md §C). The field list is declared
// locally (the exact contract, nothing beyond it) rather than imported, and the
// module is loaded through a non-literal specifier so tsc never has to resolve it
// statically: this endpoint verifies and fails soft to {available:false} whether
// or not src/metrics/** has landed yet (module-doctrine.md rule 6).
interface EngramMetricsSummary {
  totalAttempts: number | null;
  engineFailures: number | null;
  healthyAttempts: number | null;
  recallCoverage: number | null;
  zeroResultRate: number | null;
  avgReturned: number | null;
  failureRate: number | null;
  p50LatencyMs: number | null;
  p95LatencyMs: number | null;
  byStore: unknown;
  indexFreshness: unknown;
  windowDays: number | null;
}

const RECALL_METRICS_MODULE_SPECIFIER = "../metrics/recall-metrics.ts";

async function engramMetricsSummary(runtime: HenryRuntime): Promise<{ available: boolean } & Partial<EngramMetricsSummary>> {
  try {
    const mod = (await import(RECALL_METRICS_MODULE_SPECIFIER)) as {
      summarizeRecallMetrics?: (config: HenryRuntime["config"], windowDays?: number) => Promise<EngramMetricsSummary>;
    };
    if (typeof mod.summarizeRecallMetrics !== "function") return { available: false };
    const summary = await mod.summarizeRecallMetrics(runtime.config);
    return { available: true, ...summary };
  } catch {
    return { available: false };
  }
}

const AUTH_ALERT_WINDOW_MS = 10 * 60 * 1000;

/** Most recent provider auth failure in `events` (newest-first, per ActivityLog#list), or null. Powers §B1's re-login banner. */
function scanAuthAlert(events: ActivityEvent[]): { provider: ProviderName; at: string } | null {
  const cutoff = Date.now() - AUTH_ALERT_WINDOW_MS;
  for (const event of events) {
    if (event.kind !== "run.failed" || !event.provider) continue;
    if (event.metadata?.authFailure !== true) continue;
    const at = new Date(event.timestamp).getTime();
    if (!Number.isFinite(at) || at < cutoff) continue;
    return { provider: event.provider, at: event.timestamp };
  }
  return null;
}

const RELOGIN_COMMANDS: Record<ProviderName, string> = { codex: "codex login", claude: "claude" };

/**
 * Opens Terminal pre-typed with the provider's login command (§B1). Args are
 * passed as an array (spawn, not a shell string) and the AppleScript string
 * literal is built via JSON.stringify — same quoting idiom as the existing
 * osascript call in src/reminders/service.ts.
 */
function relogin(provider: ProviderName): Promise<void> {
  const command = RELOGIN_COMMANDS[provider];
  const script = `tell application "Terminal" to do script ${JSON.stringify(command)}\ntell application "Terminal" to activate`;
  return new Promise((resolve, reject) => {
    const child = spawn("osascript", ["-e", script], { stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Error(`osascript exited ${code}`))));
  });
}

function json(response: http.ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  response.end(JSON.stringify(value));
}

async function rawBody(request: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += piece.length;
    if (total > 256_000) throw new Error("request body too large");
    chunks.push(piece);
  }
  // Decode ONCE after concat (audit L2): stringifying each chunk separately mangles
  // any multi-byte character that straddles a chunk boundary into U+FFFD.
  return Buffer.concat(chunks).toString("utf8");
}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await rawBody(request);
  try { return JSON.parse(raw || "{}") as Record<string, unknown>; } catch { throw new Error("Invalid JSON body"); }
}

/** POST /login is a plain browser form submit, so its body is urlencoded rather than JSON. */
async function formBody(request: http.IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await rawBody(request));
}

function redirect(response: http.ServerResponse, location: string, headers: http.OutgoingHttpHeaders = {}): void {
  response.writeHead(302, { location, "cache-control": "no-store", ...headers });
  response.end();
}

/** A browser navigation (send it to the login page) vs. an API/fetch call (answer with JSON). */
function wantsHtml(request: http.IncomingMessage): boolean {
  return (request.headers.accept || "").includes("text/html");
}

function localOrigin(request: http.IncomingMessage): boolean {
  const origin = request.headers.origin;
  return !origin || /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(origin);
}

function loopback(host: string): boolean { return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]"; }

/** The socket's peer, not the configured bind host — this is what decides the local-admin bypass. */
function remoteIsLoopback(request: http.IncomingMessage): boolean {
  const address = request.socket.remoteAddress || "";
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  return bare === "::1" || /^127\./.test(bare);
}

/**
 * SHA-256(candidate) vs SHA-256(expected), compared via crypto.timingSafeEqual. Hashing
 * both sides first (rather than comparing the raw strings) means the two buffers handed to
 * timingSafeEqual are ALWAYS the same 32-byte length regardless of what the caller sent —
 * timingSafeEqual throws on a length mismatch, and a raw `===`/manual compare bails out at
 * the first differing byte, either of which would let an attacker learn something about the
 * secret's length or content from response timing. Hashing first closes both leaks.
 */
function secretEquals(candidate: string, expected: string): boolean {
  const a = crypto.createHash("sha256").update(candidate).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * The pre-session dashboard credential (old `authorized()`): the startup token
 * presented as `Authorization: Bearer` or `x-henry-token`. This path maps to admin,
 * but it no longer waves every loopback request through — the bypass below owns that
 * decision now, so turning the bypass off actually closes it.
 */
function tokenAdmin(request: http.IncomingMessage, runtime: HenryRuntime): boolean {
  const token = runtime.config.dashboardToken;
  if (!token) return false;
  if (!loopback(runtime.config.host) && !runtime.config.allowRemoteDashboard) return false;
  const authorization = request.headers.authorization || "";
  const headerToken = request.headers["x-henry-token"];
  return secretEquals(authorization, `Bearer ${token}`)
    || (typeof headerToken === "string" && secretEquals(headerToken, token));
}

const SYNTHETIC_ADMIN: SessionUser = { userId: "local", username: "luvish", role: "admin" };

/**
 * settings `dashboard.auth.localAdminBypass` (default TRUE) — read straight off
 * disk per request with a {} fallback: no settings util (another module owns that
 * file) and no cache, so flipping the setting takes effect immediately.
 * Both the nested shape and the flat dotted key are honoured, since data/settings.json
 * is a flat record today and the settings util may nest it tomorrow.
 */
async function localAdminBypassEnabled(runtime: HenryRuntime): Promise<boolean> {
  let settings: Record<string, unknown> = {};
  try { settings = JSON.parse(await fs.readFile(runtime.config.settingsPath, "utf8")) as Record<string, unknown>; } catch { /* no settings file: default applies */ }
  const flat = settings["dashboard.auth.localAdminBypass"];
  if (typeof flat === "boolean") return flat;
  const dashboard = settings.dashboard as Record<string, unknown> | undefined;
  const auth = dashboard?.auth as Record<string, unknown> | undefined;
  return auth?.localAdminBypass !== false;
}

/**
 * Who is calling, in priority order: a valid `henry_sess` cookie, else the remote
 * token header (admin), else the local-admin bypass (Luvish on this machine),
 * else nobody. A stale cookie never costs Luvish his access — it just falls
 * through to the bypass.
 */
async function sessionUserFor(request: http.IncomingMessage, runtime: HenryRuntime): Promise<SessionUser | undefined> {
  const session = readSession(request.headers.cookie);
  if (session) return session;
  if (tokenAdmin(request, runtime)) return SYNTHETIC_ADMIN;
  if (remoteIsLoopback(request) && await localAdminBypassEnabled(runtime)) return SYNTHETIC_ADMIN;
  return undefined;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * A logged-in browser hitting a page gated to roles it doesn't have (wave 2 hardening: a
 * bare redirect to /login was confusing UX for someone who IS authenticated — they'd just
 * see the login form again with no explanation of what went wrong). This renders a small
 * inline page instead, naming who they're signed in as and what the page needs, with a
 * one-click way to switch accounts. Only ever reached for a GET + Accept: text/html request
 * from a user who HAS a session but the wrong role — an anonymous/forged-cookie request
 * still gets the plain /login redirect, and every JSON caller still gets the unchanged
 * 401/403 body.
 */
function wrongRolePage(response: http.ServerResponse, user: SessionUser, roles: Role[]): void {
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>Henry</title></head>`
    + `<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5;">`
    + `<p>Signed in as ${escapeHtml(user.username)} (${escapeHtml(user.role)}) — this page needs ${escapeHtml(roles.join(" or "))}. `
    + `<a href="/logout">Switch account</a></p></body></html>`;
  response.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  response.end(html);
}

/**
 * Per-route role gate. It must fail exactly the same way the top-level admin gate does:
 * 302 to /login for a logged-out browser navigation, 401/403 JSON for everyone else. A
 * logged-in browser with the WRONG role gets the inline wrongRolePage instead of the login
 * redirect — the JSON shape for both cases is byte-for-byte what it always was. Narrows
 * `user` on success so callers don't need a non-null assertion afterwards.
 */
function roleGate(user: SessionUser | undefined, roles: Role[], request: http.IncomingMessage, response: http.ServerResponse): user is SessionUser {
  if (requireRole(user, ...roles)) return true;
  if (request.method === "GET" && wantsHtml(request)) {
    if (user) { wrongRolePage(response, user, roles); return false; }
    redirect(response, "/login");
    return false;
  }
  json(response, user ? 403 : 401, { error: user ? `requires role: ${roles.join(" or ")}` : "dashboard authentication required" });
  return false;
}

export function startDashboard(runtime: HenryRuntime): http.Server {
  if (!loopback(runtime.config.host) && (!runtime.config.allowRemoteDashboard || !runtime.config.dashboardToken)) {
    throw new Error("Remote dashboard is disabled; bind HENRY_HOST to loopback or configure HENRY_ALLOW_REMOTE_DASHBOARD=true with HENRY_DASHBOARD_TOKEN");
  }
  const server = http.createServer(async (request, response) => {
    try {
      if (!loopback(runtime.config.host) && !runtime.config.allowRemoteDashboard) throw new Error("Remote dashboard is disabled; bind HENRY_HOST to loopback or explicitly enable a token-protected remote dashboard");
      const url = new URL(request.url || "/", `http://${runtime.config.host}:${runtime.config.port}`);
      // Auth gate. /login and /api/health are reachable logged-out, and /logout only
      // ever destroys the caller's own session. Everything else below — every personal
      // route Luvish had — is admin-only; the local-admin bypass inside sessionUserFor
      // is what keeps his localhost experience exactly as it was.
      const route = url.pathname.replace(/\/$/, "") || "/";
      const publicPath = route === "/login" || route === "/logout" || route === "/api/health";
      const user = await sessionUserFor(request, runtime);
      if (!publicPath && !requireRole(user, "admin")) {
        if (request.method === "GET" && wantsHtml(request)) {
          if (user) { wrongRolePage(response, user, ["admin"]); return; }
          redirect(response, "/login");
          return;
        }
        json(response, user ? 403 : 401, { error: user ? "admin access required" : "dashboard authentication required" });
        return;
      }
      if (request.method === "GET" && route === "/login") {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(await loginHtml());
        return;
      }
      if (request.method === "GET" && route === "/logout") {
        endSession(request.headers.cookie);
        redirect(response, "/login", { "set-cookie": clearedSessionCookie() });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" }); response.end(DASHBOARD_HTML); return;
      }
      if (request.method === "GET" && (url.pathname === "/memory" || url.pathname === "/memory/")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(await observatoryHtml());
        return;
      }
      if (request.method === "GET" && (url.pathname === "/logs" || url.pathname === "/logs/")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(await logsHtml());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/logs") {
        // The activity journal IS the log of record — every run, memory op, workflow,
        // approval, and failure already lands there. Newest first, capped.
        const limit = Math.min(2000, Math.max(20, Number(url.searchParams.get("limit")) || 500));
        json(response, 200, { events: await runtime.activity.list(limit) });
        return;
      }
      if (request.method === "GET" && (url.pathname === "/chat" || url.pathname === "/chat/")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(await chatHtml());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/chat/history") {
        json(response, 200, { messages: await readChatTranscript(runtime) });
        return;
      }
      if (request.method === "GET" && url.pathname === "/holo.js") {
        response.writeHead(200, { "content-type": "application/javascript; charset=utf-8", "cache-control": "no-store" });
        response.end(await holoJs());
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/health") { json(response, 200, { ok: true, timestamp: new Date().toISOString() }); return; }
      if (request.method === "GET" && url.pathname === "/api/status") { json(response, 200, await runtime.status()); return; }
      if (request.method === "GET" && url.pathname === "/api/activity") { json(response, 200, await runtime.activity.list(Number(url.searchParams.get("limit")) || 100)); return; }
      if (request.method === "GET" && url.pathname === "/api/events") {
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "connection": "keep-alive",
        });
        sseWrite(response, "hello", { timestamp: new Date().toISOString() });

        let lastSeenId: string | null = null;

        const tick = async (): Promise<void> => {
          if (response.writableEnded) return;
          let events: ActivityEvent[] = [];
          // 40 (not 20): also the scan window for scanAuthAlert's 10-minute lookback below.
          try { events = await runtime.activity.list(40); } catch { /* activity log hiccup; skip this tick's diff */ }
          if (events.length) {
            const chronological = [...events].reverse(); // oldest -> newest
            const startIndex = lastSeenId ? chronological.findIndex((event) => event.id === lastSeenId) + 1 : 0;
            for (const event of chronological.slice(startIndex)) sseWrite(response, "activity", event);
            lastSeenId = chronological[chronological.length - 1].id;
          }
          try {
            const resources = await sampleResources();
            const pending = await runtime.approvals.list("pending").catch(() => []);
            const admission = sharedAdmissionController().snapshot();
            const lastActivityAt = events[0]?.timestamp ?? null;
            const lastActivityAgeSec = lastActivityAt
              ? Math.max(0, Math.round((Date.now() - new Date(lastActivityAt).getTime()) / 1000))
              : null;
            sseWrite(response, "resources", {
              ...resources,
              agentState: {
                state: admission.running > 0 ? "working" : "idle",
                running: admission.running,
                heavy: admission.heavyRunning,
                queued: admission.queued,
              },
              heartbeat: {
                uptimeSec: Math.round(process.uptime()),
                lastActivityAt,
                lastActivityAgeSec,
                pendingApprovals: pending.length,
              },
              authAlert: scanAuthAlert(events),
            });
          } catch { /* resource sampling hiccup; skip this tick's resources push */ }
        };

        await tick();
        const interval = setInterval(() => { void tick(); }, EVENTS_POLL_MS);
        request.on("close", () => clearInterval(interval));
        response.on("close", () => clearInterval(interval));
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/approvals") { json(response, 200, await runtime.approvals.list()); return; }
      if (request.method === "GET" && url.pathname === "/api/workflows") { json(response, 200, await runtime.scheduler.definitions()); return; }
      if (request.method === "GET" && url.pathname === "/api/jobs") {
        json(response, 200, { summary: await runtime.jobs.store.summary(), applications: await runtime.jobs.store.list() }); return;
      }
      if (request.method === "GET" && url.pathname === "/api/settings") { json(response, 200, { provider: runtime.config.provider }); return; }
      if (request.method === "GET" && url.pathname === "/api/knowledge") {
        startDistillationInit(runtime);
        const distillation = distillationCache ?? (distillationError ? { error: distillationError } : { loading: true });
        if (knowledgeStatsCache) { json(response, 200, { stats: knowledgeStatsCache, distillation }); return; }
        if (knowledgeStatsError) { json(response, 200, { stats: null, error: knowledgeStatsError, distillation }); return; }
        try {
          await fs.access(runtime.config.knowledgeDbPath);
        } catch (error) {
          json(response, 200, { stats: null, error: error instanceof Error ? error.message : String(error), distillation });
          return;
        }
        startKnowledgeInit(runtime);
        json(response, 200, { stats: null, loading: true, distillation });
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/engram/metrics") {
        json(response, 200, await engramMetricsSummary(runtime)); return;
      }
      if (request.method === "GET" && url.pathname === "/api/covers") {
        const dir = path.join(runtime.config.dataDir, "cover-letters");
        try {
          const entries = await fs.readdir(dir, { withFileTypes: true });
          const files = await Promise.all(
            entries.filter((entry) => entry.isFile()).map(async (entry) => {
              const stat = await fs.stat(path.join(dir, entry.name));
              return { name: entry.name, size: stat.size, mtime: stat.mtime.toISOString() };
            }),
          );
          files.sort((a, b) => (a.mtime < b.mtime ? 1 : a.mtime > b.mtime ? -1 : 0));
          json(response, 200, files);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") { json(response, 200, []); return; }
          throw error;
        }
        return;
      }
      if (request.method === "GET" && url.pathname === "/api/memory/graph") { json(response, 200, runtime.memory.graph()); return; }
      if (request.method === "GET" && url.pathname === "/api/memory/recall") {
        const query = url.searchParams.get("q") || "";
        if (!query) { json(response, 400, { error: "q is required" }); return; }
        json(response, 200, await runtime.memory.recall(query)); return;
      }

      if (request.method === "GET" && route === "/admin/knowledge") {
        if (!roleGate(user, ["admin"], request, response)) return;
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        response.end(await knowledgeAdminHtml());
        return;
      }
      if (request.method === "GET" && route === "/api/knowledge/domains") {
        if (!roleGate(user, ["admin"], request, response)) return;
        json(response, 200, domainPolicy(runtime.config.settingsPath));
        return;
      }

      if (!localOrigin(request)) { json(response, 403, { error: "cross-origin request rejected" }); return; }
      // Below the CSRF line with every other mutating route: the login form posts
      // same-origin, so the localOrigin check above is exactly the protection it wants.
      if (request.method === "POST" && route === "/login") {
        const form = await formBody(request);
        const username = (form.get("username") || "").trim();
        const password = form.get("password") || "";
        const account = username && password ? verifyLogin(username, password) : undefined;
        // Never echo the attempt back in the URL — no username, no reason, no timing tell.
        if (!account) { redirect(response, "/login?error=1"); return; }
        // Henry's dashboard is admin-only — every account lands on mission control at "/".
        redirect(response, "/", { "set-cookie": issueSession(account).cookie });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/settings/provider") {
        const input = await body(request);
        json(response, 200, { provider: await runtime.setProvider(String(input.provider) as "codex" | "claude") }); return;
      }
      if (request.method === "POST" && url.pathname === "/api/ask") {
        const input = await body(request); const prompt = String(input.prompt || "");
        if (!prompt) { json(response, 400, { error: "prompt is required" }); return; }
        json(response, 200, await runtime.agent.run(prompt)); return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/send") {
        const input = await body(request); const prompt = String(input.prompt || "").trim();
        if (!prompt) { json(response, 400, { error: "prompt is required" }); return; }
        // Recorded BEFORE any work: if "New chat" clears the transcript while this
        // send is running, the final append below must notice and drop the reply.
        const generation = chatClearGeneration;
        // Append BEFORE committing SSE headers (audit 2026-08-09 B-H1): a failed
        // write after writeHead made the outer catch call json() on a headers-sent
        // response, and that second throw killed the whole process (repl included).
        await appendChatMessages(runtime, [{ role: "user", text: prompt, at: new Date().toISOString() }]);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
          "connection": "keep-alive",
        });
        try {
          // Same surface-session model as the REPL, its own surface: provider-side
          // context persists across web messages until "New chat" resets it.
          const result = await runtime.agent.run(prompt, {
            surface: "web-chat",
            onEvent: (event) => {
              const text = event.parsed && typeof (event.parsed as Record<string, unknown>).text === "string"
                ? String((event.parsed as Record<string, unknown>).text)
                : undefined;
              if (text?.trim()) sseWrite(response, "token", { text: text.endsWith("\n") ? text : `${text}\n` });
            },
          });
          // The transcript records the authoritative final response even if the
          // browser tab bailed mid-stream — reload shows the full reply.
          await appendChatMessages(runtime, [{ role: "henry", text: result.response, at: new Date().toISOString() }], { ifGeneration: generation });
          sseWrite(response, "done", { response: result.response, provider: result.provider, durationMs: result.durationMs });
        } catch (error) {
          sseWrite(response, "error", { error: error instanceof Error ? error.message : String(error) });
        }
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/chat/clear") {
        await clearChatTranscript(runtime);
        // Fresh conversation = fresh provider context: drop the web-chat surface session.
        runtime.agent.providerRunner.sessions().reset("web-chat");
        json(response, 200, { cleared: true });
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/dispatch") {
        const input = await body(request); const role = String(input.role || "architect"); const task = String(input.task || "");
        if (!task) { json(response, 400, { error: "task is required" }); return; }
        json(response, 200, await runtime.luna.dispatch(role, task, { allowEdits: input.allowEdits === true })); return;
      }
      if (request.method === "POST" && url.pathname === "/api/engram/recall") {
        const input = await body(request);
        const query = String(input.query || "").trim();
        if (!query) { json(response, 400, { error: "query is required" }); return; }
        const store = input.store === "knowledge" ? "knowledge" : "personal";
        const k = Math.min(50, Math.max(1, Math.trunc(Number(input.k)) || 8));
        const startedAt = Date.now();
        // Read-only lab recall: bypass HenryMemory/KnowledgeBase's recall() wrappers (which
        // mark-used + reinforce on every call) and hit the engine directly with those signals
        // off, exactly like runtime.memory.recall does for the real path minus the side effects.
        const engine = store === "knowledge" ? runtime.knowledge.engine : runtime.memory.engine;
        try {
          const trace = await engine.recallTrace(query, { k, associative: true, markUsed: false, reinforce: false });
          json(response, 200, {
            results: trace.results.map((result) => ({
              id: result.id,
              content: result.content.slice(0, 300),
              source: result.source,
              tier: result.tier,
              score: result.score,
              why: result.why,
            })),
            activation: {
              seeds: trace.trace.seeds.map((seed) => seed.id),
              activated: trace.trace.activations.map((activation) => activation.id),
            },
            latencyMs: Date.now() - startedAt,
          });
        } catch (error) {
          json(response, 200, {
            results: [],
            activation: { seeds: [], activated: [] },
            latencyMs: Date.now() - startedAt,
            error: error instanceof Error ? error.message : String(error),
          });
        }
        return;
      }
      if (request.method === "POST" && url.pathname === "/api/relogin") {
        const input = await body(request);
        const provider = input.provider === "codex" || input.provider === "claude" ? input.provider : null;
        if (!provider) { json(response, 400, { error: 'provider must be "codex" or "claude"' }); return; }
        try {
          await relogin(provider);
          json(response, 200, { ok: true, provider });
        } catch (error) {
          json(response, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
        }
        return;
      }
      if (request.method === "POST" && route === "/api/knowledge/domains") {
        if (!roleGate(user, ["admin"], request, response)) return;
        const input = await body(request);
        const domain = typeof input.domain === "string" ? input.domain : "";
        if (!domain || typeof input.enabled !== "boolean") {
          json(response, 400, { error: "body must be { domain: string, enabled: boolean }" });
          return;
        }
        try {
          setDomainEnabled(runtime.config.settingsPath, domain, input.enabled);
        } catch (error) {
          json(response, 400, { error: error instanceof Error ? error.message : String(error) });
          return;
        }
        json(response, 200, domainPolicy(runtime.config.settingsPath));
        return;
      }
      const approval = url.pathname.match(/^\/api\/approvals\/([^/]+)\/(approve|execute)$/);
      if (request.method === "POST" && approval) {
        const id = decodeURIComponent(approval[1]);
        if (approval[2] === "approve") { await runtime.approve(id); json(response, 200, { ok: true }); return; }
        json(response, 200, { ok: true, result: await runtime.executeApproval(id) }); return;
      }
      json(response, 404, { error: "not found" });
    } catch (error) {
      // headersSent guard (audit 2026-08-09 B-H1): once a streaming/HTML response has
      // committed headers, a second writeHead throws INSIDE this catch — an unhandled
      // rejection that takes down the process. End the stream instead.
      if (response.headersSent) { if (!response.writableEnded) response.end(); }
      else json(response, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });
  server.listen(runtime.config.port, runtime.config.host);
  return server;
}
