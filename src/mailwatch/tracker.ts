import fs from "node:fs/promises";
import type { HenryConfig } from "../config.ts";

/** Same rails as `service.ts`'s `MailWatchNotifier` — no shared type, kept local (doctrine rule 7). */

export const APP_STATUSES = ["applied", "viewed", "shortlisted", "assessment", "interview", "rejected", "offer"] as const;
export type AppStatus = (typeof APP_STATUSES)[number];

/**
 * Statuses worth buzzing Luvish's phone about (his rule, 2026-08-15): "don't remind me for
 * applied applications, only if the application has had a response other than rejected —
 * keep updating the job index and send me that, not reminders".
 *
 * So `applied` (an acknowledgement, not a response) and `rejected` (a response, but not one
 * he wants pinged) are recorded SILENTLY. The tracker index, the history trail, and the
 * Engram events stay complete for every status — this set gates notifications only.
 */
export const NOTIFY_STATUSES: ReadonlySet<AppStatus> = new Set<AppStatus>([
  "viewed", "shortlisted", "assessment", "interview", "offer",
]);

function isAppStatus(value: string): value is AppStatus {
  return (APP_STATUSES as readonly string[]).includes(value);
}

export interface ParsedApp {
  company: string;
  role: string;
  source: string;
  status: AppStatus;
  dateText: string;
  subject: string;
}

/**
 * Defensively parses one `APP|<company>|<role>|<source>|<status>|<date-ish>|<subject>` line —
 * mirrors `parseAlertLine`'s discipline in `service.ts`. The model's raw output is never trusted
 * structurally: missing fields, an unknown status, or a short/garbage line all return `undefined`.
 */
export function parseAppLine(line: string): ParsedApp | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("APP|")) return undefined;
  const parts = trimmed.split("|");
  if (parts.length < 7) return undefined;
  const [, rawCompany, rawRole, rawSource, rawStatus, rawDate, ...rest] = parts;
  const company = rawCompany.trim().replace(/\|/g, "/");
  const role = rawRole.trim().replace(/\|/g, "/");
  const source = rawSource.trim().replace(/\|/g, "/");
  const status = rawStatus.trim().toLowerCase();
  const dateText = rawDate.trim();
  const subject = rest.join("|").trim();
  if (!company || !role || !source || !subject) return undefined;
  if (!isAppStatus(status)) return undefined;
  return { company, role, source, status, dateText: dateText || "unknown", subject };
}

export interface TrackerHistoryEntry {
  status: AppStatus;
  /** The "date-ish" text lifted from the email — never parsed into a real Date (too unreliable across providers). */
  dateText: string;
  subject: string;
  /** ISO timestamp of when Henry actually recorded this transition. */
  recordedAt: string;
  /** True when recorded by a backfill() seeding sweep — digests must not count these as "today's" news. */
  backfill?: boolean;
}

export interface TrackerEntry {
  /** `company::role`, lowercased — the identity key applications are deduped and updated on. */
  key: string;
  company: string;
  role: string;
  source: string;
  status: AppStatus;
  appliedAt: string;
  lastUpdate: string;
  history: TrackerHistoryEntry[];
}

export interface TrackerState {
  entries: TrackerEntry[];
}

/** One concrete application event (new application or status transition) — the unit the memory layer records. */
export interface TrackerAppEvent {
  company: string;
  role: string;
  status: AppStatus;
  subject: string;
  dateText: string;
  isNew: boolean;
}

export interface TrackerUpdateResult {
  /** One "📋 Application update: ..." message per genuinely new application or status transition. */
  notifications: string[];
  created: number;
  changed: number;
  /** Mirrors notifications 1:1 with structured data, so callers can memorize transitions. */
  events: TrackerAppEvent[];
}

export interface TrackerSummary {
  jsonPath: string;
  markdownPath: string;
  total: number;
  byStatus: Record<AppStatus, number>;
}

function entryKey(company: string, role: string): string {
  return `${company.trim().toLowerCase()}::${role.trim().toLowerCase()}`;
}

function isTrackerEntry(value: unknown): value is TrackerEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TrackerEntry>;
  return (
    typeof candidate.key === "string" &&
    typeof candidate.company === "string" &&
    typeof candidate.role === "string" &&
    typeof candidate.source === "string" &&
    typeof candidate.status === "string" && isAppStatus(candidate.status) &&
    typeof candidate.appliedAt === "string" &&
    typeof candidate.lastUpdate === "string" &&
    Array.isArray(candidate.history)
  );
}

async function readTrackerState(config: HenryConfig): Promise<TrackerState> {
  try {
    const raw = JSON.parse(await fs.readFile(config.jobTrackerPath, "utf8")) as Partial<TrackerState>;
    const entries = Array.isArray(raw.entries) ? raw.entries.filter(isTrackerEntry) : [];
    return { entries };
  } catch {
    return { entries: [] };
  }
}

async function writeTrackerState(config: HenryConfig, state: TrackerState): Promise<void> {
  await fs.mkdir(config.dataDir, { recursive: true, mode: 0o700 });
  const tmp = `${config.jobTrackerPath}.tmp-${process.pid}`;
  await fs.writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await fs.rename(tmp, config.jobTrackerPath);
  await fs.chmod(config.jobTrackerPath, 0o600).catch(() => undefined);
  // The .md is the artifact Luvish actually reads — no restrictive mode, same as cover letters / linkedin drafts.
  await fs.writeFile(config.jobTrackerMarkdownPath, renderMarkdown(state), "utf8");
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "/").trim() || "—";
}

/** Renders the canonical ledger: a table sorted by last-update desc, plus a per-application history section. */
export function renderMarkdown(state: TrackerState, now: Date = new Date()): string {
  const sorted = [...state.entries].sort((a, b) => (b.lastUpdate || "").localeCompare(a.lastUpdate || ""));
  const lines: string[] = ["# Job Application Tracker", "", `_Last regenerated: ${now.toISOString()}_`, ""];
  if (sorted.length === 0) {
    lines.push(
      "No applications tracked yet. Run `npx tsx src/cli.ts mailwatch backfill --days 30` to seed this ledger from recent inbox history, or wait for the next scheduled mailwatch check.",
      "",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push("| Company | Role | Source | Current status | Applied | Last update |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const entry of sorted) {
    lines.push(
      `| ${escapeCell(entry.company)} | ${escapeCell(entry.role)} | ${escapeCell(entry.source)} | ${escapeCell(entry.status)} | ${escapeCell(entry.appliedAt)} | ${escapeCell(entry.lastUpdate)} |`,
    );
  }
  lines.push("", "## History", "");
  for (const entry of sorted) {
    lines.push(`### ${entry.company} — ${entry.role}`);
    for (const item of entry.history) {
      lines.push(`- ${escapeCell(item.dateText)} — **${item.status}** — "${item.subject}" (${entry.source}, recorded ${item.recordedAt})`);
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Applies `APP|...` lines (from either `check()`'s live scan or `backfill()`'s wider sweep) to
 * the canonical ledger, then regenerates `job-tracker.md`. Dedupe is via the tracker's own
 * history — not mailwatch's `seenIds` — so a re-seen email for a company+role at its current
 * status is a no-op. APP_STATUSES is progression-ordered, and status only ever moves FORWARD
 * along it (or into a terminal outcome — rejected/offer are always accepted): a lower status
 * is a late/out-of-order email that joins the history silently, with no notification and no
 * headline change. `options.backfill` stamps every recorded history entry so digests can tell
 * seeded history from live news. Re-reads the state file immediately before writing (the
 * reminders-store clobber lesson).
 */
export async function updateTracker(config: HenryConfig, lines: string[], options: { backfill?: boolean } = {}): Promise<TrackerUpdateResult> {
  const parsed = lines.map(parseAppLine).filter((item): item is ParsedApp => item !== undefined);
  if (parsed.length === 0) return { notifications: [], created: 0, changed: 0, events: [] };

  const state = await readTrackerState(config);
  const notifications: string[] = [];
  const events: TrackerAppEvent[] = [];
  let created = 0;
  let changed = 0;
  // Silent history appends (regressions, appliedAt backfills) don't count as
  // created/changed but still have to be persisted.
  let dirty = false;
  const now = new Date().toISOString();
  const stamp = (app: ParsedApp): TrackerHistoryEntry => ({
    status: app.status, dateText: app.dateText, subject: app.subject, recordedAt: now,
    ...(options.backfill ? { backfill: true } : {}),
  });

  for (const app of parsed) {
    const key = entryKey(app.company, app.role);
    const entry = state.entries.find((candidate) => candidate.key === key);
    if (!entry) {
      state.entries.push({
        key, company: app.company, role: app.role, source: app.source, status: app.status,
        // appliedAt only ever comes from an "applied" email (audit M20): an entry first
        // seen through a rejection must not claim the rejection's date as its application
        // date. A later applied confirmation backfills it below.
        appliedAt: app.status === "applied" ? app.dateText : "",
        lastUpdate: now,
        history: [stamp(app)],
      });
      created += 1;
      if (NOTIFY_STATUSES.has(app.status)) notifications.push(`📋 Application update: ${app.company} ${app.role} → ${app.status}`);
      events.push({ company: app.company, role: app.role, status: app.status, subject: app.subject, dateText: app.dateText, isNew: true });
      continue;
    }
    const lastStatus = entry.history[entry.history.length - 1]?.status;
    if (lastStatus === app.status || entry.status === app.status) continue; // already recorded — no-op, no notify
    const advances = APP_STATUSES.indexOf(app.status) > APP_STATUSES.indexOf(entry.status)
      || app.status === "rejected" || app.status === "offer";
    if (!advances) {
      // Progression guard (audit M16): a lower status is a late/re-scanned email —
      // keep it for the audit trail, but never walk "interview" back to "viewed"
      // and never ping Luvish about old news.
      entry.history.push(stamp(app));
      if (app.status === "applied" && !entry.appliedAt) entry.appliedAt = app.dateText; // first applied seen
      dirty = true;
      continue;
    }
    entry.company = app.company;
    entry.role = app.role;
    entry.source = app.source || entry.source;
    entry.status = app.status;
    entry.lastUpdate = now;
    entry.history.push(stamp(app));
    changed += 1;
    if (NOTIFY_STATUSES.has(app.status)) notifications.push(`📋 Application update: ${app.company} ${app.role} → ${app.status}`);
    events.push({ company: app.company, role: app.role, status: app.status, subject: app.subject, dateText: app.dateText, isNew: false });
  }

  if (created > 0 || changed > 0 || dirty) await writeTrackerState(config, state);
  return { notifications, created, changed, events };
}

/** Read-only summary for `henry mailwatch tracker` — never writes. */
export async function trackerSummary(config: HenryConfig): Promise<TrackerSummary> {
  const state = await readTrackerState(config);
  const byStatus = Object.fromEntries(APP_STATUSES.map((status) => [status, 0])) as Record<AppStatus, number>;
  for (const entry of state.entries) byStatus[entry.status] += 1;
  return { jsonPath: config.jobTrackerPath, markdownPath: config.jobTrackerMarkdownPath, total: state.entries.length, byStatus };
}

export interface TrackerDigest {
  date: string;
  appliedToday: number;
  updatesToday: number;
  total: number;
  byStatus: Record<AppStatus, number>;
  /** One compact Telegram-ready line — "just the index", no per-application detail. */
  line: string;
}

/** recordedAt timestamps come from Henry's own clock, so local-day bucketing is honest. */
function isLocalDay(iso: string, now: Date): boolean {
  const stamp = new Date(iso);
  return stamp.getFullYear() === now.getFullYear() && stamp.getMonth() === now.getMonth() && stamp.getDate() === now.getDate();
}

/**
 * The twice-daily "job index" (Luvish, 2026-08-09: "just the index, telegram me the
 * index"): counts only, computed locally from the tracker ledger — zero provider spend.
 */
export async function trackerDigest(config: HenryConfig, now: Date = new Date()): Promise<TrackerDigest> {
  const state = await readTrackerState(config);
  const byStatus = Object.fromEntries(APP_STATUSES.map((status) => [status, 0])) as Record<AppStatus, number>;
  let appliedToday = 0;
  let updatesToday = 0;
  for (const entry of state.entries) {
    byStatus[entry.status] += 1;
    for (const item of entry.history) {
      // Backfilled entries were RECORDED today but describe weeks-old inbox history —
      // counting them would make a seeding sweep read as a monster application day.
      if (item.backfill) continue;
      if (!isLocalDay(item.recordedAt, now)) continue;
      if (item.status === "applied") appliedToday += 1;
      else updatesToday += 1;
    }
  }
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const statusBits = APP_STATUSES.filter((status) => byStatus[status] > 0).map((status) => `${status} ${byStatus[status]}`).join(" · ");
  const line = `📊 Job index ${date} — today: ${appliedToday} applied, ${updatesToday} update${updatesToday === 1 ? "" : "s"} · tracked ${state.entries.length} (${statusBits || "none yet"})`;
  return { date, appliedToday, updatesToday, total: state.entries.length, byStatus, line };
}
