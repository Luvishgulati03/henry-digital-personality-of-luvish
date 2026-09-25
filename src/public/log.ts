import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

/**
 * THE PUBLIC SURFACE'S REQUEST LOG: `<dataDir>/logs/public.log`, JSON lines, size-rotated.
 *
 * One line per request the public face (or the tunnel gate) answers, plus a few events (tunnel
 * transitions, page-reported asset errors). It exists so "the site went down" can be diagnosed
 * after the fact. It NEVER holds message text, audio, IP addresses, cookies, or contact details:
 * paths are logged without their query string (with anything that looks like an email address or
 * phone number masked), and a visitor is a short HMAC of their cookie under a key that lives only
 * in this process's memory, so ids correlate within one run and mean nothing outside it.
 */

export const PUBLIC_LOG_FILE = "public.log";
export const START_LOG_FILE = "henry-start.log";
export const LOG_MAX_BYTES = 5 * 1024 * 1024;
export const LOG_KEEP_FILES = 3;

export function logsDir(dataDir: string): string {
  return path.join(dataDir, "logs");
}

/**
 * An append-only file that rotates by size: `name` → `name.1` → `name.2`, keeping `keep` files in
 * total. Writes are synchronous (lines are small and rare) so ordering holds and a crash loses
 * nothing already logged. Every failure is swallowed: logging must never break a request.
 */
export class RotatingLog {
  private size = -1;

  constructor(readonly file: string, private readonly maxBytes = LOG_MAX_BYTES, private readonly keep = LOG_KEEP_FILES) {}

  append(text: string): void {
    try {
      if (this.size < 0) {
        fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
        try { this.size = fs.statSync(this.file).size; } catch { this.size = 0; }
      }
      const bytes = Buffer.byteLength(text);
      if (this.size > 0 && this.size + bytes > this.maxBytes) this.rotate();
      fs.appendFileSync(this.file, text, { mode: 0o600 });
      this.size += bytes;
    } catch { /* never let logging break the caller */ }
  }

  private rotate(): void {
    for (let index = this.keep - 1; index >= 1; index -= 1) {
      const from = index === 1 ? this.file : `${this.file}.${index - 1}`;
      const to = `${this.file}.${index}`;
      try { fs.renameSync(from, to); } catch { /* a missing generation is fine */ }
    }
    if (this.keep <= 1) { try { fs.rmSync(this.file, { force: true }); } catch { /* ignore */ } }
    this.size = 0;
  }
}

/** Every generation of a rotated log, oldest first. */
export function logGenerations(file: string, keep = LOG_KEEP_FILES): string[] {
  const files: string[] = [];
  for (let index = keep - 1; index >= 1; index -= 1) files.push(`${file}.${index}`);
  files.push(file);
  return files.filter((candidate) => fs.existsSync(candidate));
}

const EMAIL = /[^\s/@]+@[^\s/@]+\.[^\s/@]+/g;
const PHONE = /\+?\d[\d\s().-]{6,}\d/g;

/** Masks anything that looks like an email address or a phone number. */
export function maskContacts(text: string): string {
  return text.replace(EMAIL, "[masked]").replace(PHONE, "[masked]");
}

/** A request path fit for the log: no query, printable ASCII, contact-looking runs masked, capped. */
export function loggablePath(pathname: string): string {
  let clean = pathname.split("?")[0].replace(/[^\x21-\x7e]/g, "");
  try { clean = decodeURIComponent(clean).replace(/[^\x21-\x7e]/g, ""); } catch { /* keep the raw form */ }
  return maskContacts(clean).slice(0, 160) || "/";
}

/** A CF-Ray value (hex id plus optional colo), or undefined. */
export function cfRay(request: http.IncomingMessage): string | undefined {
  const value = request.headers["cf-ray"];
  return typeof value === "string" && /^[0-9a-f]{8,32}(?:-[A-Z]{3})?$/i.test(value.trim()) ? value.trim() : undefined;
}

/** Fields a turn or voice request adds to its request line. Nothing here may carry visitor content. */
export interface PublicLogAnnotation {
  route?: string;
  visitor?: string;
  owner?: boolean;
  provider?: string;
  model?: string;
  firstTextMs?: number | null;
  firstSentMs?: number | null;
  totalMs?: number;
  queueMs?: number;
  sttMs?: number;
  ttsMs?: number;
  voice?: boolean;
  streamed?: number;
  replaced?: boolean;
  blocked?: boolean;
  busy?: boolean;
  rateLimited?: boolean;
  failed?: string;
  event?: string;
  [key: string]: unknown;
}

export interface PublicLogOptions {
  /** Test seam: a fixed key makes visitor hashes predictable. Production draws 32 random bytes. */
  key?: Buffer;
  now?: () => number;
  maxBytes?: number;
  keep?: number;
}

export class PublicLog {
  readonly file: string;
  private readonly out: RotatingLog;
  private readonly key: Buffer;
  private readonly now: () => number;
  private readonly notes = new WeakMap<http.ServerResponse, PublicLogAnnotation>();

  constructor(dataDir: string, options: PublicLogOptions = {}) {
    this.file = path.join(logsDir(dataDir), PUBLIC_LOG_FILE);
    this.out = new RotatingLog(this.file, options.maxBytes ?? LOG_MAX_BYTES, options.keep ?? LOG_KEEP_FILES);
    this.key = options.key ?? crypto.randomBytes(32);
    this.now = options.now ?? Date.now;
  }

  /** A per-process pseudonym for a visitor cookie value (never the cookie itself). */
  visitorHash(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return crypto.createHmac("sha256", this.key).update(id).digest("base64url").slice(0, 12);
  }

  /** Adds fields to the line this response will be logged with. */
  annotate(response: http.ServerResponse, fields: PublicLogAnnotation): void {
    const existing = this.notes.get(response);
    this.notes.set(response, existing ? { ...existing, ...fields } : { ...fields });
  }

  /** Writes one event line (tunnel transitions, page-reported errors, ...). */
  event(kind: string, fields: Record<string, unknown> = {}): void {
    this.write({ ts: new Date(this.now()).toISOString(), kind, ...fields });
  }

  /**
   * Logs `response` once it finishes (or the client goes away): method, path without query,
   * status, duration, bytes written, whether it came through the tunnel, CF-Ray, and whatever the
   * handler annotated. Counting bytes wraps write/end on this one response object.
   */
  track(request: http.IncomingMessage, response: http.ServerResponse, url: URL, tunnelled: boolean): void {
    const started = this.now();
    let bytes = 0;
    const count = (chunk: unknown, encoding?: unknown): void => {
      if (typeof chunk === "string") bytes += Buffer.byteLength(chunk, typeof encoding === "string" ? encoding as BufferEncoding : "utf8");
      else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
    };
    const write = response.write.bind(response) as (...args: unknown[]) => boolean;
    const end = response.end.bind(response) as (...args: unknown[]) => http.ServerResponse;
    (response as unknown as { write: (...args: unknown[]) => boolean }).write = (...args: unknown[]) => { count(args[0], args[1]); return write(...args); };
    (response as unknown as { end: (...args: unknown[]) => http.ServerResponse }).end = (...args: unknown[]) => { if (typeof args[0] !== "function") count(args[0], args[1]); return end(...args); };
    let done = false;
    const finish = (aborted: boolean): void => {
      if (done) return;
      done = true;
      const note = this.notes.get(response) ?? {};
      const ray = cfRay(request);
      this.write({
        ts: new Date(started).toISOString(),
        kind: "request",
        method: request.method ?? "GET",
        path: loggablePath(url.pathname),
        status: response.statusCode,
        ms: this.now() - started,
        bytes,
        tunnelled,
        ...(ray ? { ray } : {}),
        ...(aborted ? { aborted: true } : {}),
        ...note,
      });
    };
    response.once("finish", () => finish(false));
    response.once("close", () => finish(!response.writableFinished));
  }

  private write(entry: Record<string, unknown>): void {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(entry)) if (value !== undefined) clean[key] = value;
    this.out.append(`${JSON.stringify(clean)}\n`);
  }
}

/**
 * Samples a noisy event for the activity journal: the first occurrence in each window is
 * recorded, later ones are counted and reported with the next recorded one. Keeps a burst of
 * refusals (a script hammering the chat) from flooding the journal while still showing its size.
 */
export class EventSampler {
  private readonly windows = new Map<string, { until: number; suppressed: number }>();

  constructor(private readonly windowMs = 60_000, private readonly now: () => number = Date.now) {}

  /** Returns how many were suppressed since the last recorded one when this one should be recorded, else undefined. */
  take(key: string): number | undefined {
    const at = this.now();
    const window = this.windows.get(key);
    if (window && at < window.until) { window.suppressed += 1; return undefined; }
    const suppressed = window?.suppressed ?? 0;
    this.windows.set(key, { until: at + this.windowMs, suppressed: 0 });
    return suppressed;
  }
}

/** Parsed lines of a JSONL log across its generations, oldest first; unreadable lines are skipped. */
export function readLogEntries(file: string, keep = LOG_KEEP_FILES): Array<Record<string, unknown>> {
  const entries: Array<Record<string, unknown>> = [];
  for (const generation of logGenerations(file, keep)) {
    let text = "";
    try { text = fs.readFileSync(generation, "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) entries.push(parsed as Record<string, unknown>);
      } catch { /* a torn line */ }
    }
  }
  return entries;
}
