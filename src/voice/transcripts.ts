import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { readSettings, updateSettings } from "../util/settings.ts";

/**
 * VOICE TRANSCRIPT STORE — what Henry heard, kept on the owner's terms.
 *
 * A transcript is the owner's own speech, and a log line is forever, so this store is the
 * explicit, owner-controlled alternative to folding voice turns into the activity log:
 *
 * - text is kept for `retentionDays` (default 60) and pruned on every write;
 * - audio is written ONLY while `recordAudio` is on (default OFF), and kept for
 *   `audioRetentionDays` (default 7), pruned independently of the text;
 * - everything lives under `<dataDir>/voice/` with 0600/0700 modes, never leaves the
 *   machine, and is never committed.
 *
 * SQLite (WAL) rather than JSON because the dashboard, the Telegram bridge and a CLI
 * one-shot can all write at once, and a transaction closes the read-modify-write race that
 * JSON stores had (the 2026-08-06 reminders-cache clobber lesson).
 *
 * A transcript's STATE tells the owner what happened to the words:
 *   transcribed → armed for a typed yes (Telegram) or shown for review (Talk page)
 *   confirmed   → the owner typed yes; the words went to the brain
 *   answered    → Henry replied (reply text stored beside the transcript)
 *   dropped     → the owner typed no, or typed something else instead
 *   expired     → nobody confirmed within the window
 *   failed      → download, conversion, or transcription failed (no words kept)
 */

export interface VoiceSettings {
  retentionDays: number;
  recordAudio: boolean;
  audioRetentionDays: number;
  /** Owner-facing voice UI (the dashboard's Talk page). Default on. */
  talkEnabled: boolean;
  /** When on, transcripts are neither stored nor reflected into memory/activity beyond the
   *  in-flight turn — a hard "do not keep what I say" switch. Default off. */
  privateMode: boolean;
}

export const VOICE_SETTINGS_DEFAULTS: Readonly<VoiceSettings> = Object.freeze({
  retentionDays: 60,
  recordAudio: false,
  audioRetentionDays: 7,
  talkEnabled: true,
  privateMode: false,
});

const RETENTION_RANGE = { min: 1, max: 365 };
const AUDIO_RETENTION_RANGE = { min: 1, max: 90 };

function clampDays(value: unknown, fallback: number, range: { min: number; max: number }): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(range.max, Math.max(range.min, Math.round(parsed)));
}

function readBool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Reads persisted `settings.json → voice` only — the shape `updateVoiceSettings`
 *  reads-merges-writes against. */
function readPersistedVoiceSettings(settingsPath: string): VoiceSettings {
  const raw = readSettings(settingsPath).voice;
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  return {
    retentionDays: clampDays(record.retentionDays, VOICE_SETTINGS_DEFAULTS.retentionDays, RETENTION_RANGE),
    recordAudio: record.recordAudio === true,
    audioRetentionDays: clampDays(record.audioRetentionDays, VOICE_SETTINGS_DEFAULTS.audioRetentionDays, AUDIO_RETENTION_RANGE),
    talkEnabled: readBool(record.talkEnabled, VOICE_SETTINGS_DEFAULTS.talkEnabled),
    privateMode: readBool(record.privateMode, VOICE_SETTINGS_DEFAULTS.privateMode),
  };
}

/** `settings.json → voice`. Missing or malformed reads as the defaults. */
export function readVoiceSettings(settingsPath: string): VoiceSettings {
  return readPersistedVoiceSettings(settingsPath);
}

/** Read-merge-write through the shared settings helper; returns what is now in force. */
export function updateVoiceSettings(settingsPath: string, patch: Partial<VoiceSettings>): VoiceSettings {
  const current = readPersistedVoiceSettings(settingsPath);
  const next: VoiceSettings = {
    retentionDays: patch.retentionDays === undefined ? current.retentionDays : clampDays(patch.retentionDays, current.retentionDays, RETENTION_RANGE),
    recordAudio: patch.recordAudio === undefined ? current.recordAudio : patch.recordAudio === true,
    audioRetentionDays: patch.audioRetentionDays === undefined ? current.audioRetentionDays : clampDays(patch.audioRetentionDays, current.audioRetentionDays, AUDIO_RETENTION_RANGE),
    talkEnabled: patch.talkEnabled === undefined ? current.talkEnabled : patch.talkEnabled === true,
    privateMode: patch.privateMode === undefined ? current.privateMode : patch.privateMode === true,
  };
  updateSettings(settingsPath, { voice: next });
  return readVoiceSettings(settingsPath);
}

/** Where a voice turn came from: the dashboard's Talk page, or the Telegram bridge. */
export type TranscriptSurface = "talk" | "telegram";
export type TranscriptState = "transcribed" | "confirmed" | "answered" | "dropped" | "expired" | "failed";

export interface TranscriptRecord {
  id: string;
  at: string;
  surface: TranscriptSurface;
  language?: string;
  durationSeconds?: number;
  bytes?: number;
  /** Wall-clock transcription time, for latency and real-time factor. */
  sttMs?: number;
  /** Whisper's native transcript, including Devanagari and Latin text. What the owner reads. */
  text: string;
  /** Legacy pre-conversion words from records created while Roman Hinglish conversion was active.
   *  New records preserve Whisper's native output directly and leave this field empty. */
  original?: string;
  /** True when `original` is present — Whisper's own output contained Devanagari. */
  mixed: boolean;
  /** Opaque authenticated dashboard principal that created a Talk-page transcript. */
  principal?: string;
  state: TranscriptState;
  conversationId?: string;
  reply?: string;
  replyAt?: string;
  /** Present only while a recording is kept on disk. */
  audioPath?: string;
  error?: string;
}

export interface TranscriptFilter {
  surface?: TranscriptSurface;
  language?: string;
  state?: TranscriptState;
  /** Case-insensitive substring over the words and the reply. */
  q?: string;
  limit?: number;
}

export interface TranscriptStats {
  total: number;
  today: number;
  bySurface: Record<TranscriptSurface, number>;
  unconfirmed: number;
  failed: number;
  audioKept: number;
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

interface Row {
  id: string; at: string; surface: string; language: string | null; durationSeconds: number | null;
  bytes: number | null; sttMs: number | null; text: string; original: string | null; state: string;
  principal: string | null; conversationId: string | null; reply: string | null; replyAt: string | null; audioPath: string | null; error: string | null;
}

const SURFACES: TranscriptSurface[] = ["talk", "telegram"];
const STATES: TranscriptState[] = ["transcribed", "confirmed", "answered", "dropped", "expired", "failed"];

export function isTranscriptSurface(value: unknown): value is TranscriptSurface {
  return typeof value === "string" && (SURFACES as string[]).includes(value);
}
export function isTranscriptState(value: unknown): value is TranscriptState {
  return typeof value === "string" && (STATES as string[]).includes(value);
}

export class VoiceTranscriptStore {
  private readonly db: Database.Database;
  private readonly dir: string;

  constructor(private readonly dataDir: string, private readonly settingsPath: string) {
    this.dir = path.join(dataDir, "voice");
    fs.mkdirSync(path.join(this.dir, "audio"), { recursive: true, mode: 0o700 });
    this.db = new Database(path.join(this.dir, "transcripts.db"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS transcripts (
      id TEXT PRIMARY KEY,
      at TEXT NOT NULL,
      surface TEXT NOT NULL,
      language TEXT,
      durationSeconds REAL,
      bytes INTEGER,
      sttMs INTEGER,
      text TEXT NOT NULL,
      original TEXT,
      principal TEXT,
      state TEXT NOT NULL,
      conversationId TEXT,
      reply TEXT,
      replyAt TEXT,
      audioPath TEXT,
      error TEXT
    )`);
    this.db.exec("CREATE INDEX IF NOT EXISTS transcripts_at ON transcripts(at DESC)");
    try { fs.chmodSync(path.join(this.dir, "transcripts.db"), 0o600); } catch { /* best effort */ }
  }

  settings(): VoiceSettings { return readVoiceSettings(this.settingsPath); }

  /** Writes a transcript (or a failure with no words) and prunes what has aged out. Never
   *  writes anything while `privateMode` is on — the caller still gets a record back so a
   *  turn can proceed, but nothing lands on disk. */
  record(input: {
    surface: TranscriptSurface; text: string; original?: string; principal?: string; language?: string; durationSeconds?: number; bytes?: number;
    sttMs?: number; state?: TranscriptState; conversationId?: string; error?: string; at?: string;
  }): TranscriptRecord {
    // `original` is kept only when it actually differs from the (Roman) text — a caller that
    // always passes Whisper's raw output must not store a duplicate of unchanged English.
    const original = input.original !== undefined && input.original !== input.text ? input.original : undefined;
    const record: TranscriptRecord = {
      id: randomUUID(),
      at: input.at ?? new Date().toISOString(),
      surface: input.surface,
      ...(input.language ? { language: input.language } : {}),
      ...(input.durationSeconds !== undefined ? { durationSeconds: input.durationSeconds } : {}),
      ...(input.bytes !== undefined ? { bytes: input.bytes } : {}),
      ...(input.sttMs !== undefined ? { sttMs: input.sttMs } : {}),
      text: input.text,
      ...(original ? { original } : {}),
      mixed: Boolean(original),
      ...(input.principal ? { principal: input.principal } : {}),
      state: input.state ?? (input.error ? "failed" : "transcribed"),
      ...(input.conversationId ? { conversationId: input.conversationId } : {}),
      ...(input.error ? { error: input.error } : {}),
    };
    if (this.settings().privateMode) return record;
    this.db.prepare(`INSERT INTO transcripts (id, at, surface, language, durationSeconds, bytes, sttMs, text, original, principal, state, conversationId, reply, replyAt, audioPath, error)
      VALUES (@id, @at, @surface, @language, @durationSeconds, @bytes, @sttMs, @text, @original, @principal, @state, @conversationId, NULL, NULL, NULL, @error)`).run({
      id: record.id, at: record.at, surface: record.surface, language: record.language ?? null,
      durationSeconds: record.durationSeconds ?? null, bytes: record.bytes ?? null, sttMs: record.sttMs ?? null,
      text: record.text, original: original ?? null, principal: input.principal ?? null, state: record.state,
      conversationId: record.conversationId ?? null, error: record.error ?? null,
    });
    this.prune();
    return record;
  }

  /** State transitions and the reply, from whichever surface learns them. */
  update(id: string, patch: { state?: TranscriptState; reply?: string; conversationId?: string; error?: string }): TranscriptRecord | undefined {
    const sets: string[] = [];
    const params: Record<string, unknown> = { id };
    if (patch.state) { sets.push("state = @state"); params.state = patch.state; }
    if (patch.reply !== undefined) { sets.push("reply = @reply", "replyAt = @replyAt"); params.reply = patch.reply; params.replyAt = new Date().toISOString(); }
    if (patch.conversationId !== undefined) { sets.push("conversationId = @conversationId"); params.conversationId = patch.conversationId; }
    if (patch.error !== undefined) { sets.push("error = @error"); params.error = patch.error; }
    if (sets.length) this.db.prepare(`UPDATE transcripts SET ${sets.join(", ")} WHERE id = @id`).run(params);
    return this.get(id);
  }

  get(id: string): TranscriptRecord | undefined {
    const row = this.db.prepare("SELECT * FROM transcripts WHERE id = ?").get(id) as Row | undefined;
    return row ? fromRow(row) : undefined;
  }

  list(filter: TranscriptFilter = {}): TranscriptRecord[] {
    const where: string[] = [];
    const params: Record<string, unknown> = {};
    if (filter.surface) { where.push("surface = @surface"); params.surface = filter.surface; }
    if (filter.state) { where.push("state = @state"); params.state = filter.state; }
    if (filter.language) { where.push("language = @language"); params.language = filter.language; }
    if (filter.q?.trim()) { where.push("(lower(text) LIKE @q OR lower(coalesce(original, '')) LIKE @q OR lower(coalesce(reply, '')) LIKE @q)"); params.q = `%${filter.q.trim().toLowerCase()}%`; }
    const limit = Math.min(500, Math.max(1, Math.round(filter.limit ?? 100)));
    const rows = this.db.prepare(`SELECT * FROM transcripts ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY at DESC LIMIT ${limit}`).all(params) as Row[];
    return rows.map(fromRow);
  }

  stats(now: Date = new Date()): TranscriptStats {
    const rows = this.db.prepare("SELECT surface, state, at, audioPath FROM transcripts").all() as Array<Pick<Row, "surface" | "state" | "at" | "audioPath">>;
    const dayStart = new Date(now); dayStart.setHours(0, 0, 0, 0);
    const stats: TranscriptStats = { total: rows.length, today: 0, bySurface: { talk: 0, telegram: 0 }, unconfirmed: 0, failed: 0, audioKept: 0 };
    for (const row of rows) {
      if (new Date(row.at).getTime() >= dayStart.getTime()) stats.today += 1;
      if (isTranscriptSurface(row.surface)) stats.bySurface[row.surface] += 1;
      if (row.state === "transcribed") stats.unconfirmed += 1;
      if (row.state === "failed") stats.failed += 1;
      if (row.audioPath) stats.audioKept += 1;
    }
    return stats;
  }

  /**
   * Keeps a recording ONLY while the owner has switched recording on. Returns the path, or
   * undefined when nothing was written, so callers never have to check the setting themselves.
   */
  saveAudio(id: string, wav: Uint8Array): string | undefined {
    if (!this.settings().recordAudio) return undefined;
    if (!this.get(id)) return undefined;
    const target = path.join(this.dir, "audio", `${id}.wav`);
    fs.writeFileSync(target, wav, { mode: 0o600 });
    this.db.prepare("UPDATE transcripts SET audioPath = ? WHERE id = ?").run(target, id);
    return target;
  }

  /** The kept recording's path, or undefined when none is (or no longer is) on disk. */
  audioPath(id: string): string | undefined {
    const record = this.get(id);
    if (!record?.audioPath) return undefined;
    try { fs.accessSync(record.audioPath); return record.audioPath; } catch { return undefined; }
  }

  /** Text older than the retention window is deleted; audio older than its own window is unlinked. */
  prune(now: Date = new Date()): { textDeleted: number; audioDeleted: number } {
    const settings = this.settings();
    const textCutoff = new Date(now.getTime() - settings.retentionDays * 86_400_000).toISOString();
    const audioCutoff = new Date(now.getTime() - settings.audioRetentionDays * 86_400_000).toISOString();
    const expiredAudio = this.db.prepare("SELECT id, audioPath FROM transcripts WHERE audioPath IS NOT NULL AND at < ?").all(audioCutoff) as Array<Pick<Row, "id" | "audioPath">>;
    for (const row of expiredAudio) {
      if (row.audioPath) try { fs.unlinkSync(row.audioPath); } catch { /* already gone */ }
      this.db.prepare("UPDATE transcripts SET audioPath = NULL WHERE id = ?").run(row.id);
    }
    const expiredText = this.db.prepare("SELECT audioPath FROM transcripts WHERE at < ?").all(textCutoff) as Array<Pick<Row, "audioPath">>;
    for (const row of expiredText) if (row.audioPath) try { fs.unlinkSync(row.audioPath); } catch { /* already gone */ }
    const deleted = this.db.prepare("DELETE FROM transcripts WHERE at < ?").run(textCutoff).changes;
    return { textDeleted: deleted, audioDeleted: expiredAudio.length };
  }

  /** Switching recording off also removes every kept recording: "off" must mean nothing on disk. */
  discardAllAudio(): number {
    const rows = this.db.prepare("SELECT id, audioPath FROM transcripts WHERE audioPath IS NOT NULL").all() as Array<Pick<Row, "id" | "audioPath">>;
    for (const row of rows) {
      if (row.audioPath) try { fs.unlinkSync(row.audioPath); } catch { /* already gone */ }
      this.db.prepare("UPDATE transcripts SET audioPath = NULL WHERE id = ?").run(row.id);
    }
    return rows.length;
  }

  close(): void { this.db.close(); }
}

function fromRow(row: Row): TranscriptRecord {
  return {
    id: row.id, at: row.at,
    surface: isTranscriptSurface(row.surface) ? row.surface : "talk",
    ...(row.language ? { language: row.language } : {}),
    ...(row.durationSeconds !== null ? { durationSeconds: row.durationSeconds } : {}),
    ...(row.bytes !== null ? { bytes: row.bytes } : {}),
    ...(row.sttMs !== null ? { sttMs: row.sttMs } : {}),
    text: row.text,
    ...(row.original ? { original: row.original } : {}),
    mixed: Boolean(row.original),
    ...(row.principal ? { principal: row.principal } : {}),
    state: isTranscriptState(row.state) ? row.state : "transcribed",
    ...(row.conversationId ? { conversationId: row.conversationId } : {}),
    ...(row.reply !== null ? { reply: row.reply } : {}),
    ...(row.replyAt ? { replyAt: row.replyAt } : {}),
    ...(row.audioPath ? { audioPath: row.audioPath } : {}),
    ...(row.error ? { error: row.error } : {}),
  };
}
