import { guardPublicReply, type GuardResult } from "./guard.ts";
import { classifyLimit, LIMIT_RESPONSE_MAX_CHARS } from "../providers/limits.ts";
import { isAuthFailureResponse } from "../providers/runner.ts";

/**
 * STREAMED PUBLIC REPLIES, GUARDED BY SENTENCE.
 *
 * Model text arrives as small deltas (Claude --include-partial-messages) or as one whole message
 * (Codex). Nothing reaches a visitor until a whole sentence is buffered AND everything sent so far
 * plus that sentence passes the output guard (src/public/guard.ts): checking the cumulative text
 * catches a secret or path that straddles a sentence break before its second half is sent. The
 * first sentence that fails stops the stream for good ("tripped"); the caller then REPLACES what
 * the visitor saw with the guarded full reply (the neutral refusal line). Text that looks like a
 * CLI notice rather than an answer (a usage-limit or logged-out message) only pauses the stream
 * ("held"): the finished run decides what the visitor gets.
 *
 * A provider attempt starting again (failover) discards what the earlier attempt streamed: a
 * `reset` goes out and the new attempt streams from scratch.
 */

export type StreamOutput = { type: "sentence"; text: string } | { type: "reset" };

export type StreamFinish =
  /** Everything streamed so far stands; `pieces` (possibly none) complete the reply. */
  | { action: "append"; pieces: string[] }
  /** What was streamed must be withdrawn and replaced by `text` (guarded full reply). */
  | { action: "replace"; text: string };

const ABBREVIATION = /(?:^|[\s(])(?:\d+|[A-Za-z]|e\.g|i\.e|etc|vs|approx|Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|Inc|Ltd|Co|No)\.$/i;

/**
 * Index just past the first complete sentence in `text` (its trailing whitespace included), or -1
 * while the sentence may still be growing. A boundary is `.`, `!`, `?` or `…` (plus closing quotes
 * or brackets) followed by whitespace, or a newline. A number, initial, or common abbreviation
 * before a full stop ("1.", "e.g.", "Dr.") is not a boundary.
 */
export function sentenceEnd(text: string): number {
  const boundary = /[.!?…]+["'”’)\]]*(?=\s)|\n/g;
  let match: RegExpExecArray | null;
  while ((match = boundary.exec(text))) {
    const end = match.index + match[0].length;
    if (match[0] !== "\n" && match[0].endsWith(".") && ABBREVIATION.test(text.slice(0, end))) continue;
    let after = end;
    while (after < text.length && /\s/.test(text[after])) after += 1;
    return after;
  }
  return -1;
}

/** Splits already-final text into sentence pieces (the tail without a boundary is the last piece). */
export function sentencePieces(text: string): string[] {
  const pieces: string[] = [];
  let rest = text;
  for (;;) {
    const cut = sentenceEnd(rest);
    if (cut <= 0) break;
    pieces.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest.trim()) pieces.push(rest);
  return pieces.filter((piece) => piece.trim());
}

function looksLikeProviderNotice(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length >= LIMIT_RESPONSE_MAX_CHARS) return false;
  return classifyLimit(trimmed).limited || isAuthFailureResponse(trimmed);
}

export class PublicReplyStream {
  private buffer = "";
  private emitted = "";
  private state: "streaming" | "held" | "tripped" = "streaming";
  /** Why the guard stopped the stream (owner-side logging only). */
  tripReason?: string;
  /** Sentences sent to the visitor across the whole turn (resets included). */
  sentencesSent = 0;
  resets = 0;

  constructor(
    private readonly ownerName: string,
    private readonly blockedValues: Array<string | undefined>,
    private readonly emit: (output: StreamOutput) => void,
  ) {}

  /** The text the visitor currently holds from this attempt. */
  get streamed(): string { return this.emitted; }
  get tripped(): boolean { return this.state === "tripped"; }

  /**
   * The run broke the public sandbox (a tool call or a loaded tool): withdraw what was streamed
   * and send nothing more for the rest of this turn, whatever follows.
   */
  halt(reason: string): void {
    if (this.halted) return;
    this.halted = true;
    this.tripReason = reason;
    if (this.emitted) { this.resets += 1; this.emit({ type: "reset" }); }
    this.buffer = "";
    this.emitted = "";
    this.state = "tripped";
  }
  private halted = false;

  /** A provider attempt began: drop anything an earlier attempt streamed. */
  start(): void {
    if (this.halted) return;
    if (this.emitted) { this.resets += 1; this.emit({ type: "reset" }); }
    this.buffer = "";
    this.emitted = "";
    this.state = "streaming";
    this.tripReason = undefined;
  }

  push(text: string): void {
    if (this.state !== "streaming" || !text) return;
    this.buffer += text;
    for (;;) {
      const cut = sentenceEnd(this.buffer);
      if (cut <= 0) return;
      const sentence = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (!this.offer(sentence)) return;
    }
  }

  private offer(sentence: string): boolean {
    const candidate = this.emitted + sentence;
    if (!candidate.trim()) { this.emitted = candidate; return true; }
    const guard = guardPublicReply(candidate, this.ownerName, this.blockedValues);
    if (!guard.ok) { this.state = "tripped"; this.tripReason = guard.reason; return false; }
    if (looksLikeProviderNotice(candidate)) { this.state = "held"; return false; }
    this.emitted = candidate;
    this.sentencesSent += 1;
    this.emit({ type: "sentence", text: sentence });
    return true;
  }

  /**
   * Reconciles the stream with the run's final, fully guarded reply (the authority). When the
   * visitor's streamed text is a prefix of it, the rest is appended; otherwise (the guard tripped,
   * the stream was held on a notice, or the final message differs) it is replaced.
   */
  finish(final: GuardResult): StreamFinish {
    const sent = this.emitted.trimStart();
    if (!sent.trim()) return { action: "append", pieces: sentencePieces(final.text) };
    if (final.ok && this.state !== "tripped") {
      // The final text is trimmed; what streamed may end in whitespace the visitor already has.
      if (final.text.startsWith(sent)) return { action: "append", pieces: sentencePieces(final.text.slice(sent.length)) };
      const bare = sent.trimEnd();
      if (final.text.startsWith(bare)) return { action: "append", pieces: sentencePieces(final.text.slice(bare.length).trimStart()) };
    }
    return { action: "replace", text: final.text };
  }
}
