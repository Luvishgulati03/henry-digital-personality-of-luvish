import type { Visitor, VolunteeredDetails } from "./visitors.ts";
import { detailLines } from "./notes.ts";

/**
 * Telegram to the OWNER ONLY. `send` is the owner-notification channel (src/notify/telegram.ts,
 * whose chat id comes from config and is never caller-supplied); nothing here can address anyone
 * else. Two messages exist:
 *
 *   - a short notice that a new visitor started chatting (at most one per noticeIntervalMs),
 *   - the visitor's own "Ping <owner>" request with the details they volunteered, marked
 *     unverified: once per visitor, and at most pingsPerHour across all visitors.
 */

export type OwnerSend = (text: string) => Promise<boolean>;

export type PingOutcome =
  | { ok: true }
  | { ok: false; reason: "already" | "cap" | "unavailable" | "failed" };

const MAX_PREVIEW = 160;

function preview(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_PREVIEW ? `${clean.slice(0, MAX_PREVIEW)}…` : clean;
}

export class OwnerPinger {
  private lastNoticeAt = -Infinity;
  private pingTimes: number[] = [];

  constructor(
    private readonly send: OwnerSend | undefined,
    private readonly options: { ownerName: string; noticeIntervalMs: number; pingsPerHour: number },
    private readonly now: () => number = Date.now,
  ) {}

  get available(): boolean { return Boolean(this.send) && this.options.pingsPerHour > 0; }

  /** Fire-and-forget "a new visitor is chatting" notice. Returns whether one was sent. */
  async noticeNewVisitor(visitor: Visitor, firstQuestion: string, channel: "chat" | "voice"): Promise<boolean> {
    if (!this.send || visitor.noticeSent) return false;
    const at = this.now();
    if (at - this.lastNoticeAt < this.options.noticeIntervalMs) return false;
    this.lastNoticeAt = at;
    visitor.noticeSent = true;
    return this.send([
      `Henry public: a new visitor started a ${channel === "voice" ? "voice" : "chat"} conversation.`,
      `First question (visitor-typed, unverified): "${preview(firstQuestion)}"`,
    ].join("\n")).catch(() => false);
  }

  async ping(visitor: Visitor, details: VolunteeredDetails): Promise<PingOutcome> {
    if (visitor.pinged) return { ok: false, reason: "already" };
    if (!this.send || this.options.pingsPerHour <= 0) return { ok: false, reason: "unavailable" };
    const at = this.now();
    this.pingTimes = this.pingTimes.filter((time) => at - time < 3_600_000);
    if (this.pingTimes.length >= this.options.pingsPerHour) return { ok: false, reason: "cap" };
    this.pingTimes.push(at);
    visitor.pinged = true;
    const lines = detailLines(details);
    const questions = visitor.questions.slice(-5).map((question) => `  - "${preview(question)}"`);
    const sent = await this.send([
      `Henry public: a visitor asked to reach you, ${this.options.ownerName}.`,
      "Details they gave (UNVERIFIED, visitor-supplied):",
      ...(lines.length ? lines.map((line) => `  ${line}`) : ["  (no details given)"]),
      ...(questions.length ? ["Recent questions:", ...questions] : []),
    ].join("\n")).catch(() => false);
    if (!sent) {
      // A failed send does not burn the visitor's one ping.
      visitor.pinged = false;
      this.pingTimes.pop();
      return { ok: false, reason: "failed" };
    }
    return { ok: true };
  }
}
