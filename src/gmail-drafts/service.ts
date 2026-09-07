import fs from "node:fs/promises";
import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { ActivityLog } from "../activity.ts";
import type { ProviderRunner } from "../providers/runner.ts";

/** Same shape as reminders'/mailwatch's notifier — kept local so this module never imports another module directly (doctrine rule 7). */
export type DraftRepliesNotifier = (message: string, title?: string) => Promise<void>;

export interface DraftedReplySummary {
  to: string;
  subject: string;
  preview: string;
}

/**
 * The thread identity of an inbox message a reply can be attached to. Structural on
 * purpose so this module never imports the gmail integration directly (doctrine rule 7);
 * `InboxMessage` satisfies it.
 */
export interface ReplySource {
  id: string;
  threadId?: string;
  /** The RFC `Message-ID` header of the message being replied to. */
  messageId?: string;
  /** That message's own `References` chain, so a reply appends rather than replaces. */
  references?: string;
  from: string;
  subject: string;
  date?: string;
}

/** Reads the recent inbox messages a drafted reply could be answering. */
export type ReplySourceReader = (limit: number) => Promise<ReplySource[]>;

/** Stages a reply for Luvish's approval. Staging only — this never sends. */
export type ReplyStager = (input: {
  to: string; subject: string; body: string;
  threadId?: string; inReplyTo?: string; references?: string;
}) => Promise<{ id: string }>;

/** Optional wiring that lets a drafted reply carry real RFC thread identity. */
export interface DraftThreading {
  readSources: ReplySourceReader;
  stage: ReplyStager;
}

export interface StagedReply {
  approvalId: string;
  to: string;
  subject: string;
  threadId?: string;
  inReplyTo?: string;
  /** True when Henry could not identify the source message, so the reply is unthreaded. */
  unthreaded?: boolean;
}

export interface DraftRepliesResult {
  drafted: DraftedReplySummary[];
  skipped: number;
  localPath: string;
  /** Approval items staged for the drafted replies (empty when threading is not wired). */
  staged: StagedReply[];
}

interface DraftBlock {
  to: string;
  subject: string;
  body: string;
}

/** `"Jane Doe" <jane@acme.com>` -> `jane@acme.com`. */
export function bareAddress(value: string): string {
  const angled = value.match(/<([^<>]+)>/);
  return (angled ? angled[1] : value).trim().toLowerCase();
}

/** Strips any number of `Re:`/`Fwd:`/`Fw:` prefixes so two sides of a thread compare equal. */
export function normalizeSubjectKey(subject: string): string {
  let text = subject.trim();
  let previous = "";
  while (text !== previous) {
    previous = text;
    text = text.replace(/^\s*(?:re|fwd?|aw|sv)\s*(?:\[\d+\])?\s*:\s*/i, "");
  }
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Associates a drafted reply with the inbox message it answers — IN CODE, by matching the
 * draft's recipient against each source's sender (and preferring an exact subject match).
 * The model is never asked to echo an identifier back, because a hallucinated or dropped id
 * would silently mis-thread a real reply. Sources are assumed newest-first (as `inbox()`
 * returns them), so an ambiguous match resolves to the most recent conversation.
 */
export function matchReplySource(block: { to: string; subject: string }, sources: ReplySource[]): ReplySource | undefined {
  const recipient = bareAddress(block.to);
  if (!recipient) return undefined;
  const candidates = sources.filter((source) => bareAddress(source.from) === recipient);
  if (!candidates.length) return undefined;
  const key = normalizeSubjectKey(block.subject);
  return candidates.find((source) => normalizeSubjectKey(source.subject) === key) || candidates[0];
}

/**
 * Defensively parses one `DRAFTED|<to>|<subject>|<preview>` summary line. Returns `undefined`
 * for `NO_REPLIES_NEEDED`, blank lines, or anything malformed — the model's raw output is
 * never trusted structurally (mirrors mailwatch's `parseAlertLine`).
 */
export function parseDraftedLine(line: string): DraftedReplySummary | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("DRAFTED|")) return undefined;
  const parts = trimmed.split("|");
  if (parts.length < 4) return undefined;
  const [, rawTo, rawSubject, ...rest] = parts;
  const to = rawTo.trim();
  const subject = rawSubject.trim();
  const preview = rest.join("|").trim();
  if (!to || !subject || !preview) return undefined;
  return { to, subject, preview };
}

/**
 * Defensively extracts `DRAFT_BEGIN ... DRAFT_END` full-body blocks from the model's raw
 * response. A malformed/incomplete block is simply not matched — never partially trusted.
 */
export function parseDraftBlocks(response: string): DraftBlock[] {
  const blocks: DraftBlock[] = [];
  const regex = /DRAFT_BEGIN\s*\r?\nTo:\s*(.*)\r?\nSubject:\s*(.*)\r?\nBody:\s*\r?\n([\s\S]*?)\r?\nDRAFT_END/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(response))) {
    const to = match[1].trim();
    const subject = match[2].trim();
    const body = match[3].trim();
    if (to && subject && body) blocks.push({ to, subject, body });
  }
  return blocks;
}

/** First few non-empty lines of the resume, used as light context rather than the full document. */
async function resumeSummary(resumePath: string, lines = 5): Promise<string> {
  try {
    const text = await fs.readFile(resumePath, "utf8");
    return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).slice(0, lines).join("\n");
  } catch {
    return "";
  }
}

async function readText(filePath: string): Promise<string> {
  try { return await fs.readFile(filePath, "utf8"); } catch { return ""; }
}

export class DraftRepliesService {
  constructor(
    private readonly config: HenryConfig,
    private readonly activity: ActivityLog,
    private readonly runner: ProviderRunner,
    private readonly notify?: DraftRepliesNotifier,
    /** Optional approval-backed mode for callers that do not use MCP Gmail drafts. */
    private readonly threading?: DraftThreading,
  ) {}

  /**
   * ONE ProviderRunner.run (codex — it has the authed gmail MCP). By default the model reads
   * unread inbox mail, drafts replies in Luvish's voice, and creates real Gmail DRAFTS (never
   * sends, never touches read-state/labels). In approval-backed threading mode, the prompt
   * suppresses MCP draft creation and matching replies are staged instead. Full bodies are
   * written to a local markdown file for audit/review.
   */
  async draftReplies(limit = 5): Promise<DraftRepliesResult> {
    const persona = await readText(path.join(this.config.rootDir, "personality.md"));
    const summary = await resumeSummary(this.config.resumeSourcePath);

    const prompt = [
      `Read my ${limit} most recent UNREAD inbox emails that genuinely need a reply — skip newsletters, receipts, notifications, and automated blasts.`,
      "For each one worth replying to: draft a reply in Luvish's voice (persona below) — concise, direct, no corporate filler. Never invent facts, commitments, dates, or numbers you don't have; use [placeholder] for anything unknown.",
      this.threading
        ? "Do NOT create a Gmail draft via an MCP tool. Henry will match each full reply to the source message and stage it for Luvish's explicit approval. NEVER send. NEVER modify read-state or labels."
        : "Then CREATE A GMAIL DRAFT for it via the gmail MCP draft-creation tool, threaded to the original message. NEVER send. NEVER modify read-state or labels.",
      "For every drafted reply, output a block in EXACTLY this format (nothing else on the DRAFT_BEGIN/DRAFT_END lines):",
      "DRAFT_BEGIN",
      "To: <recipient email address>",
      "Subject: <reply subject line>",
      "Body:",
      "<the full reply body, may span multiple lines>",
      "DRAFT_END",
      "After ALL the blocks, output exactly one summary line per draft: DRAFTED|<to>|<subject>|<first 80 chars of the reply>",
      "If nothing needs a reply, output exactly NO_REPLIES_NEEDED and nothing else.",
      `\n--- Luvish's voice (personality.md) ---\n${persona || "n/a"}`,
      `\n--- resume summary ---\n${summary || "n/a"}`,
    ].join("\n");

    const result = await this.runner.run(prompt, { provider: "codex", role: "draft-replies" });
    const response = result.response;

    const drafted: DraftedReplySummary[] = [];
    let skipped = 0;
    for (const line of response.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("DRAFTED|")) continue;
      const parsed = parseDraftedLine(trimmed);
      if (parsed) drafted.push(parsed); else skipped += 1;
    }
    const blocks = parseDraftBlocks(response);
    const staged = this.threading ? await this.stageReplies(blocks) : [];

    const localPath = await this.writeLocalDrafts(blocks.length ? blocks : drafted.map((item) => ({ to: item.to, subject: item.subject, body: item.preview })));

    await this.activity.record("gmail.drafted", `Drafted ${drafted.length} email replies`, {
      count: drafted.length, skipped, localPath, staged: staged.length,
    });

    if (drafted.length) {
      const message = staged.length
        ? `Prepared ${staged.length} replies for Luvish's approval`
        : `Drafted ${drafted.length} replies — review in Gmail drafts`;
      if (this.notify) await this.notify(message, "Henry — email drafts").catch(() => undefined);
    }

    // MCP-created Gmail drafts are safe, non-outbound artifacts. They are deliberately
    // not copied into the approval queue here; doing so would create a second send path
    // for the same reply. The opt-in `threading` mode above is the exception: its prompt
    // suppresses MCP draft creation and its stager is approval-backed by contract.
    return { drafted, skipped, localPath, staged };
  }

  private async stageReplies(blocks: DraftBlock[]): Promise<StagedReply[]> {
    if (!this.threading || !blocks.length) return [];
    const sources = await this.threading.readSources(Math.max(blocks.length * 4, 20));
    const staged: StagedReply[] = [];
    for (const block of blocks) {
      const source = matchReplySource(block, sources);
      const item = await this.threading.stage({
        to: block.to,
        subject: block.subject,
        body: block.body,
        threadId: source?.threadId,
        inReplyTo: source?.messageId,
        references: source?.references,
      });
      staged.push({
        approvalId: item.id,
        to: block.to,
        subject: block.subject,
        threadId: source?.threadId,
        inReplyTo: source?.messageId,
        unthreaded: !source,
      });
    }
    return staged;
  }

  private async writeLocalDrafts(entries: DraftBlock[]): Promise<string> {
    await fs.mkdir(this.config.draftRepliesDir, { recursive: true, mode: 0o700 });
    const date = new Date().toISOString().slice(0, 10);
    const localPath = path.join(this.config.draftRepliesDir, `replies-${date}.md`);
    const body = entries.length
      ? entries.map((entry, index) => [
          `## ${index + 1}. ${entry.subject}`,
          `**To:** ${entry.to}`,
          "",
          entry.body,
          "",
          "---",
        ].join("\n")).join("\n")
      : "No replies were needed today.\n";
    await fs.writeFile(localPath, `# Drafted replies — ${date}\n\n${body}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.chmod(localPath, 0o600).catch(() => undefined);
    return localPath;
  }
}
