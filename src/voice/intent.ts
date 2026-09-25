/**
 * When does a voice turn earn a holding phrase (a short rotating line like "Chasing that down.")?
 *
 * The Talk page plays a filler ONLY after the dashboard sends a `gathering` SSE event, so small
 * talk ("hi", "thanks", "how are you") never hears one; the orb just shows Thinking. Two
 * signals, once per turn:
 *
 *   - `request`: the words themselves clearly ask Henry to look something up
 *     (`isLookupRequest`), sent before the provider even starts;
 *   - `tool`: the provider stream actually starts a command, tool call, or web search
 *     (`isToolStart`), which covers lookups the word list misses.
 *
 * Deliberately conservative: an unclear request is NOT a lookup. Ported in spirit from
 * Kelly's src/voice/intent.ts, minus every shop/quotation/catalogue rule.
 */

const LOOKUP_PATTERNS: RegExp[] = [
  /\bresearch(?:es|ing)?\b/,
  /\blook(?:ing)?\s+(?:it\s+|that\s+|this\s+|them\s+)?up\b/,
  /\blookup\b/,
  /\bsearch(?:es|ing)?\b/,
  /\bfind\b/,
  /\bcheck\s+(?:my|on\s+my)\b/,
  /\bwhat(?:'|’)?s\s+the\s+latest\b/,
  /\bwhat\s+is\s+the\s+latest\b/,
  /\bsummari[sz](?:e|es|ing)\b/,
  /\bsummary\b/,
  /\bnews\b/,
  // "jobs", or "job" followed by a search noun. A bare "job" is praise ("good job") as often as not.
  /\bjobs\b/,
  /\bjob\s+(?:search|posts?|postings?|listings?|applications?|openings?|leads?)\b/,
  /\be-?mails?\b/,
  /\binbox\b/,
  /\bmail\b/,
  /\bcalendar\b/,
];

/** True when a spoken request is clearly research or a lookup. Never true for chit-chat. */
export function isLookupRequest(prompt: string): boolean {
  const text = prompt.normalize("NFC").toLowerCase();
  if (!text.trim()) return false;
  return LOOKUP_PATTERNS.some((pattern) => pattern.test(text));
}

const CODEX_TOOL_ITEMS = new Set(["command_execution", "mcp_tool_call", "web_search", "custom_tool_call"]);
const CLAUDE_TOOL_BLOCKS = new Set(["tool_use", "server_tool_use"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * True when a parsed provider event shows the model starting (or finishing) a command, tool
 * call, or web search:
 *   - Codex JSONL: item.started / item.completed whose item is command_execution,
 *     mcp_tool_call, web_search, or custom_tool_call;
 *   - Claude stream-json: a whole `assistant` message holding a tool_use block, or a streamed
 *     content_block_start for one.
 */
export function isToolStart(parsed: unknown): boolean {
  if (!isRecord(parsed)) return false;
  if (parsed.type === "item.started" || parsed.type === "item.completed") {
    const item = parsed.item;
    return isRecord(item) && typeof item.type === "string" && CODEX_TOOL_ITEMS.has(item.type);
  }
  if (parsed.type === "assistant") {
    const message = parsed.message;
    const content = isRecord(message) ? message.content : undefined;
    return Array.isArray(content) && content.some((block) => isRecord(block) && typeof block.type === "string" && CLAUDE_TOOL_BLOCKS.has(block.type));
  }
  if (parsed.type === "stream_event") {
    const inner = parsed.event;
    if (!isRecord(inner) || inner.type !== "content_block_start") return false;
    const block = inner.content_block;
    return isRecord(block) && typeof block.type === "string" && CLAUDE_TOOL_BLOCKS.has(block.type);
  }
  return false;
}
