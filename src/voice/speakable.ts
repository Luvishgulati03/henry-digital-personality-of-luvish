/**
 * Turns a chat reply into a short, TTS-safe sentence or two for a voice turn, and scrubs
 * anything private out of it before it can be read aloud. Ported from Kelly's speakable
 * module minus the shop/commerce parts (quote prices, quote-id extraction).
 *
 * Every string that leaves the server as speech goes through `redactForSpeech`
 * (see `finalizeSpoken` in src/voice/policy.ts): the model is TOLD not to speak private
 * data, and this is the code-level net for when it does anyway.
 */

export interface SpeakableSummaryInput {
  reply: string;
  maxChars?: number;
}

const SPOKEN_FENCE = /```spoken\s*\n?([\s\S]*?)```/i;

/** Splits a reply into its ```spoken fenced block (if any) and the reply with that block removed. */
export function extractSpokenBlock(reply: string): { block?: string; rest: string } {
  const match = SPOKEN_FENCE.exec(reply);
  if (!match) return { rest: reply };
  const rest = (reply.slice(0, match.index) + reply.slice(match.index + match[0].length)).replace(/\n{3,}/g, "\n\n").trim();
  return { block: match[1].trim(), rest };
}

/** The reply with any ```spoken fence removed, for display in chat/history. */
export function stripSpokenBlock(reply: string): string {
  return extractSpokenBlock(reply).rest;
}

function firstPlainParagraph(text: string): string {
  const trimmed = text.trim();
  const blankLine = trimmed.search(/\n\s*\n/);
  return blankLine === -1 ? trimmed : trimmed.slice(0, blankLine);
}

/** Strips markdown and normalises currency notation for a TTS engine. Pure text transform. */
export function stripForSpeech(text: string): string {
  let result = text;
  result = result.replace(/```[\s\S]*?```/g, " ");
  result = result.replace(/^#{1,6}\s*/gm, "");
  result = result.replace(/\[([^\]]*)\]\(([^)]*)\)/g, "link");
  result = result.replace(/(\*\*|__)(.*?)\1/g, "$2");
  result = result.replace(/(\*|_)(.*?)\1/g, "$2");
  result = result.replace(/`([^`]*)`/g, "$1");
  // Drop markdown table separator rows rather than reading pipes and dashes aloud.
  result = result
    .split("\n")
    .filter((line) => !/^\s*\|?[\s:|-]+\|[\s:|-]*\|?\s*$/.test(line))
    .map((line) => line.replace(/\|/g, " "))
    .join("\n");
  result = result.replace(/(?:₹|Rs\.?)\s*([0-9][0-9,]*(?:\.[0-9]+)?)/gi, (_all, amount: string) => `${amount} rupees`);
  result = result.replace(/\s+/g, " ").trim();
  return result;
}

/** Cuts text at or before maxChars, on the nearest sentence boundary when one exists. */
function capAtSentence(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const window = text.slice(0, maxChars);
  const lastBoundary = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
  if (lastBoundary > 0) return window.slice(0, lastBoundary + 1).trim();
  return window.trim();
}

/**
 * The sentence(s) a TTS voice reads for a chat turn. Prefers the ```spoken fence the model
 * was told to emit for voice turns; otherwise falls back to the reply's first plain paragraph.
 * NOT redacted — callers pass the result through `finalizeSpoken` (src/voice/policy.ts).
 */
export function speakableSummary(input: SpeakableSummaryInput): string {
  const maxChars = input.maxChars ?? 400;
  const { block, rest } = extractSpokenBlock(input.reply);
  const source = block ?? firstPlainParagraph(rest);
  return capAtSentence(stripForSpeech(source), maxChars);
}

/**
 * Splits text into sentence-sized chunks for sequential TTS synthesis — on `.`, `?`, `!`, and
 * the Devanagari danda (`।`), each kept with its own delimiter.
 */
export function splitSentences(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const pieces = trimmed.match(/[^.?!।]+[.?!।]*/gu) ?? [trimmed];
  return pieces.map((piece) => piece.trim()).filter(Boolean);
}

export const REDACTED_SPEECH = "on your screen";

/** ISO dates (2026-09-25) are useful to hear and are not private; everything else numeric-long is masked. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Masks private-looking data in text that is about to be SPOKEN: URLs carrying a query
 * string, email addresses, API-key/token-shaped strings, phone numbers (Indian and
 * international) and any run of five or more digits (OTPs, account/card numbers, PINs
 * with separators). Each becomes "on your screen". Deliberately over-eager: a masked
 * harmless number costs nothing, a spoken OTP cannot be unsaid.
 */
export function redactForSpeech(text: string): string {
  let result = text;
  // URLs with query strings (tokens, tracking ids, magic links). Before emails: a URL may hold an @.
  result = result.replace(/\b(?:https?:\/\/|www\.)[^\s?#]*\?[^\s]*/gi, REDACTED_SPEECH);
  result = result.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, REDACTED_SPEECH);
  // Known credential shapes.
  result = result.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, REDACTED_SPEECH);
  result = result.replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, REDACTED_SPEECH);
  result = result.replace(/\bgh[pousr]_[A-Za-z0-9_]{16,}/g, REDACTED_SPEECH);
  result = result.replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, REDACTED_SPEECH);
  result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, REDACTED_SPEECH);
  result = result.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, REDACTED_SPEECH);
  // Generic key-looking token: 20+ chars of [A-Za-z0-9_-] mixing letters and digits (also catches UUIDs).
  result = result.replace(/[A-Za-z0-9_-]{20,}/g, (token) => (/\d/.test(token) && /[A-Za-z]/.test(token) ? REDACTED_SPEECH : token));
  // Phone numbers and long digit runs: a digit sequence (spaces, dashes, parentheses allowed
  // between digits, optional leading + or "(") holding five or more digits.
  result = result.replace(/(?:\+|\()?\d[\d\s()-]*\d/g, (match) => {
    const trimmed = match.replace(/[\s(-]+$/, "");
    const digits = trimmed.replace(/\D/g, "").length;
    if (digits < 5 || ISO_DATE.test(trimmed)) return match;
    const trailing = match.slice(trimmed.length);
    return `${REDACTED_SPEECH}${trailing}`;
  });
  // Adjacent masks read as one.
  result = result.replace(new RegExp(`${REDACTED_SPEECH}(?:[\\s,;/]+(?:(?:and|or)\\s+)?${REDACTED_SPEECH})+`, "g"), REDACTED_SPEECH);
  return result;
}

/**
 * Streamed-token watcher for a voice turn's leading ```spoken fence. Feed every streamed
 * text chunk to `push`; its return value is what should still reach the client as a visible
 * `token` event.
 *
 *   buffering   — not yet enough text to know whether the reply opens with the fence.
 *   in-fence    — capturing the fence body (never shown) until the closing ```, at which
 *                 point `onSpoken` fires exactly once with the body through `stripForSpeech`.
 *   passthrough — the fence was consumed, or the reply proved not to open with one (the
 *                 buffered prefix is flushed on that transition).
 */
export function createSpokenFenceFilter(onSpoken: (text: string) => void): { push: (text: string) => string } {
  const opener = "```spoken";
  let phase: "buffering" | "in-fence" | "passthrough" = "buffering";
  let buffer = "";
  let fenceBody = "";

  function push(text: string): string {
    if (phase === "passthrough") return text;
    if (phase === "in-fence") {
      fenceBody += text;
      const closeIndex = fenceBody.indexOf("```");
      if (closeIndex === -1) return "";
      const body = fenceBody.slice(0, closeIndex);
      const after = fenceBody.slice(closeIndex + 3);
      fenceBody = "";
      phase = "passthrough";
      onSpoken(stripForSpeech(body));
      return after;
    }
    buffer += text;
    const trimmed = buffer.replace(/^\s+/, "");
    if (!trimmed) return "";
    const compareLen = Math.min(trimmed.length, opener.length);
    if (trimmed.slice(0, compareLen).toLowerCase() !== opener.slice(0, compareLen)) {
      phase = "passthrough";
      const flushed = buffer;
      buffer = "";
      return flushed;
    }
    if (trimmed.length < opener.length) return "";
    const rest = trimmed.slice(opener.length);
    const bodyStart = rest.startsWith("\n") ? rest.slice(1) : rest;
    phase = "in-fence";
    buffer = "";
    return push(bodyStart);
  }

  return { push };
}
