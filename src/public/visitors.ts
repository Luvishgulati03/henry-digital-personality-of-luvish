import crypto from "node:crypto";
import type { PublicHistoryMessage } from "./prompt.ts";

/**
 * Anonymous visitors, kept in memory only. A visitor is a random id in an HttpOnly cookie; the
 * server holds that visitor's capped conversation, the questions they asked, and whatever contact
 * details they volunteered. Nothing here is ever an identity or an authorization: it is a label
 * for a conversation, and dropping the cookie simply starts a new one.
 */

export const VISITOR_COOKIE = "henry_visitor";
const VISITOR_ID = /^[A-Za-z0-9_-]{24}$/;

export function newVisitorId(): string {
  return crypto.randomBytes(18).toString("base64url");
}

export function isVisitorId(value: string | undefined): value is string {
  return typeof value === "string" && VISITOR_ID.test(value);
}

export function readVisitorCookie(cookieHeader: string | undefined): string | undefined {
  if (!cookieHeader) return undefined;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== VISITOR_COOKIE) continue;
    const value = part.slice(index + 1).trim();
    return isVisitorId(value) ? value : undefined;
  }
  return undefined;
}

/** HttpOnly always; Secure whenever the request came through the tunnel (https at the edge). */
export function visitorCookie(id: string, secure: boolean, maxAgeSeconds = 86_400): string {
  return `${VISITOR_COOKIE}=${id}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}${secure ? "; Secure" : ""}`;
}

/** Contact details a visitor volunteered. Always unverified: shown to the owner as such. */
export interface VolunteeredDetails {
  name?: string;
  company?: string;
  role?: string;
  hiringFor?: string;
  contact?: string[];
  message?: string;
}

export interface Visitor {
  id: string;
  createdAt: number;
  lastSeen: number;
  history: PublicHistoryMessage[];
  /** Every question asked this session (truncated), in order. */
  questions: string[];
  details: VolunteeredDetails;
  turns: number;
  channels: Set<"chat" | "voice">;
  busy: boolean;
  noticeSent: boolean;
  pinged: boolean;
  /** Recent replies by id, so the talk page can ask for speech of a reply Henry actually gave. */
  replies: Map<string, string>;
}

const MAX_QUESTIONS = 30;
const MAX_QUESTION_CHARS = 300;
const MAX_REPLIES_KEPT = 6;

export class VisitorStore {
  private readonly visitors = new Map<string, Visitor>();

  constructor(private readonly options: { maxHistoryTurns: number; idleMs: number; maxVisitors: number }, private readonly now: () => number = Date.now) {}

  get size(): number { return this.visitors.size; }

  get(id: string): Visitor | undefined {
    return this.visitors.get(id);
  }

  /** The visitor for this id, created when new. Evicts the longest-idle idle visitor at capacity. */
  ensure(id: string): { visitor: Visitor; created: boolean; evicted?: Visitor } {
    const existing = this.visitors.get(id);
    const at = this.now();
    if (existing) { existing.lastSeen = at; return { visitor: existing, created: false }; }
    let evicted: Visitor | undefined;
    if (this.visitors.size >= this.options.maxVisitors) {
      for (const candidate of this.visitors.values()) {
        if (candidate.busy) continue;
        if (!evicted || candidate.lastSeen < evicted.lastSeen) evicted = candidate;
      }
      if (evicted) this.visitors.delete(evicted.id);
    }
    const visitor: Visitor = {
      id, createdAt: at, lastSeen: at, history: [], questions: [], details: {}, turns: 0,
      channels: new Set(), busy: false, noticeSent: false, pinged: false, replies: new Map(),
    };
    this.visitors.set(id, visitor);
    return { visitor, created: true, ...(evicted ? { evicted } : {}) };
  }

  /** Appends one exchange and keeps only the last `maxHistoryTurns` exchanges. */
  recordExchange(visitor: Visitor, message: string, reply: string, replyId: string): void {
    visitor.history.push({ role: "visitor", text: message }, { role: "henry", text: reply });
    const maxMessages = this.options.maxHistoryTurns * 2;
    if (visitor.history.length > maxMessages) visitor.history.splice(0, visitor.history.length - maxMessages);
    visitor.turns += 1;
    visitor.lastSeen = this.now();
    visitor.replies.set(replyId, reply);
    while (visitor.replies.size > MAX_REPLIES_KEPT) visitor.replies.delete(visitor.replies.keys().next().value as string);
  }

  recordQuestion(visitor: Visitor, message: string): void {
    const clean = message.replace(/\s+/g, " ").trim();
    if (!clean) return;
    const question = clean.length > MAX_QUESTION_CHARS ? `${clean.slice(0, MAX_QUESTION_CHARS)}…` : clean;
    if (visitor.questions.length < MAX_QUESTIONS) visitor.questions.push(question);
    mergeDetails(visitor.details, extractVolunteered(message));
  }

  /** Starts a fresh conversation for this visitor (history only; questions and details stay for the note). */
  resetConversation(visitor: Visitor): void {
    visitor.history = [];
    visitor.replies.clear();
  }

  /** Removes and returns every visitor idle for at least idleMs (never one mid-turn). */
  takeIdle(): Visitor[] {
    const cutoff = this.now() - this.options.idleMs;
    const idle: Visitor[] = [];
    for (const visitor of this.visitors.values()) {
      if (!visitor.busy && visitor.lastSeen <= cutoff) idle.push(visitor);
    }
    for (const visitor of idle) this.visitors.delete(visitor.id);
    return idle;
  }

  /** Removes and returns everyone (server shutdown). */
  takeAll(): Visitor[] {
    const all = [...this.visitors.values()];
    this.visitors.clear();
    return all;
  }
}

/* ---------------------------------------------------------------- *
 * Volunteered details: a cheap, conservative heuristic. Anything it
 * finds is labelled unverified wherever it is shown.
 * ---------------------------------------------------------------- */

const MAX_DETAIL_CHARS = 80;

function clip(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim().replace(/[.,;:!?]+$/, "");
  if (!clean) return undefined;
  return clean.length > MAX_DETAIL_CHARS ? `${clean.slice(0, MAX_DETAIL_CHARS)}…` : clean;
}

const NAME = /\b(?:[Mm]y name is|[Mm]y name's|I am|I'm|I’m|[Tt]his is)\s+([A-Z][a-zA-Z'’-]+(?:\s+[A-Z][a-zA-Z'’-]+)?)/;
const NOT_A_NAME = /^(?:A|An|The|Just|Not|Looking|Hiring|Interested|Curious|Here|Working|From|With|At|On|In|Glad|Happy|Sure|Sorry|Hi|Hello|Hey|Also|So|Currently|Recruiting)$/;
const COMPANY = /\b(?:from|at|with|work(?:ing)?\s+(?:at|for)|recruit(?:ing|er)\s+(?:at|for)|represent(?:ing)?)\s+([A-Z][\w&'’-]*(?:[ \t]+(?:[A-Z][\w&'’-]*|&|of|and)){0,3})/;
const ROLE = /\b(?:I'm|I’m|I am|as)\s+(?:an?\s+|the\s+)?((?:(?:senior|lead|principal|technical|tech|talent|engineering|product|staff|hr)\s+)*(?:recruiter|hiring manager|founder|co-founder|cto|ceo|coo|vp of [a-z]+|head of [a-z]+|engineering manager|product manager|sourcer|talent partner|talent acquisition(?: partner| lead)?|hr manager|investor|journalist|student))\b/i;
const HIRING = /\bhiring\s+(?:for\s+)?(?:an?\s+|the\s+)?([A-Za-z][\w\s/+.-]{2,60}?)(?=\s+(?:role|position|opening)\b|[.,;!?]|$)/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{3,5}[\s.-]?\d{3,5}(?:[\s.-]?\d{2,4})?/g;
const LINKEDIN = /(?:https?:\/\/)?(?:[a-z]{2,3}\.)?linkedin\.com\/in\/[A-Za-z0-9_-]{2,100}\/?/gi;

export function extractVolunteered(text: string): VolunteeredDetails {
  const details: VolunteeredDetails = {};
  const name = NAME.exec(text)?.[1];
  if (name && !NOT_A_NAME.test(name.split(/\s+/)[0])) details.name = clip(name);
  const company = COMPANY.exec(text)?.[1];
  if (company) details.company = clip(company);
  const role = ROLE.exec(text)?.[1];
  if (role) details.role = clip(role.toLowerCase());
  const hiring = HIRING.exec(text)?.[1];
  if (hiring) details.hiringFor = clip(hiring);
  const contact = [
    ...(text.match(EMAIL) ?? []),
    ...(text.match(LINKEDIN) ?? []),
    ...(text.match(PHONE) ?? []).filter((value) => value.replace(/\D/g, "").length >= 8),
  ].map((value) => clip(value)).filter((value): value is string => Boolean(value));
  if (contact.length) details.contact = [...new Set(contact)].slice(0, 3);
  return details;
}

/** First value wins per field; contacts accumulate (max 3). */
export function mergeDetails(target: VolunteeredDetails, incoming: VolunteeredDetails): void {
  for (const key of ["name", "company", "role", "hiringFor", "message"] as const) {
    if (!target[key] && incoming[key]) target[key] = incoming[key];
  }
  if (incoming.contact?.length) target.contact = [...new Set([...(target.contact ?? []), ...incoming.contact])].slice(0, 3);
}

/** Sanitises visitor-typed ping fields into the same shape (every field optional and clipped). */
export function detailsFromInput(input: Record<string, unknown>): VolunteeredDetails {
  const text = (key: string, max = MAX_DETAIL_CHARS): string | undefined => {
    const value = input[key];
    if (typeof value !== "string") return undefined;
    const clean = value.replace(/[\u0000-\u001f\u007f<>]/g, " ").replace(/\s+/g, " ").trim();
    if (!clean) return undefined;
    return clean.length > max ? `${clean.slice(0, max)}…` : clean;
  };
  const contact = text("contact", 120);
  return {
    ...(text("name") ? { name: text("name") } : {}),
    ...(text("company") ? { company: text("company") } : {}),
    ...(text("role") ? { role: text("role") } : {}),
    ...(text("hiringFor") ? { hiringFor: text("hiringFor") } : {}),
    ...(contact ? { contact: [contact] } : {}),
    ...(text("message", 500) ? { message: text("message", 500) } : {}),
  };
}

/* ---------------------------------------------------------------- *
 * Rate limiting and model-turn concurrency.
 * ---------------------------------------------------------------- */

/**
 * Sliding-window limiter. Keys are a visitor id and a client key; the client key is Cloudflare's
 * CF-Connecting-IP ONLY for requests that came through the tunnel (the edge sets it and a visitor
 * cannot), and the socket peer otherwise. It is used for rate limiting, never for authorization.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windows: Array<{ ms: number; max: number }>, private readonly now: () => number = Date.now, private readonly maxKeys = 10_000) {}

  /** Records a hit and returns true, or returns false (recording nothing) when any window is full. */
  take(key: string): boolean {
    const at = this.now();
    const longest = Math.max(...this.windows.map((window) => window.ms));
    const recent = (this.hits.get(key) ?? []).filter((time) => at - time < longest);
    for (const window of this.windows) {
      if (recent.filter((time) => at - time < window.ms).length >= window.max) {
        this.hits.set(key, recent);
        return false;
      }
    }
    recent.push(at);
    this.hits.delete(key);
    this.hits.set(key, recent);
    while (this.hits.size > this.maxKeys) this.hits.delete(this.hits.keys().next().value as string);
    return true;
  }
}

/** A small counting semaphore with a bounded wait queue. */
export class ConcurrencyGate {
  private running = 0;
  private readonly waiting: Array<{ grant: () => void; timer: NodeJS.Timeout }> = [];

  constructor(private readonly max: number, private readonly maxQueue: number) {}

  get active(): number { return this.running; }
  get queued(): number { return this.waiting.length; }

  /** True when a slot is free right now (acquire would not wait). */
  get free(): boolean { return this.running < this.max; }

  /**
   * Resolves to a release function once a slot is free, or null when the queue is full or the wait
   * exceeds `waitMs`. `onQueued` fires once if the caller has to wait.
   */
  acquire(waitMs: number, onQueued?: () => void): Promise<(() => void) | null> {
    const release = (): (() => void) => {
      let released = false;
      return () => {
        if (released) return;
        released = true;
        this.running -= 1;
        const next = this.waiting.shift();
        if (next) { clearTimeout(next.timer); next.grant(); }
      };
    };
    if (this.running < this.max) { this.running += 1; return Promise.resolve(release()); }
    if (this.waiting.length >= this.maxQueue) return Promise.resolve(null);
    onQueued?.();
    return new Promise((resolve) => {
      const entry = {
        grant: () => { this.running += 1; resolve(release()); },
        timer: setTimeout(() => {
          const index = this.waiting.indexOf(entry);
          if (index !== -1) this.waiting.splice(index, 1);
          resolve(null);
        }, waitMs),
      };
      entry.timer.unref?.();
      this.waiting.push(entry);
    });
  }
}
