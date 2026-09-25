import path from "node:path";
import type { HenryConfig } from "../config.ts";
import type { DispatchTier, ProviderName } from "../types.ts";

/**
 * Public mode settings: the limits and choices for Henry's public face (the chat and talk pages a
 * visitor reaches through the Cloudflare tunnel). Every value has a safe default; every key is a
 * HENRY_PUBLIC_* environment variable so nothing personal or deployment-specific lives in code.
 */
export interface PublicModeConfig {
  /** `<dataDir>/public-pack/published`: the approved pack (another module builds and publishes it). */
  packDir: string;
  maxPackBytes: number;
  maxMessageChars: number;
  /** Visitor turns kept per visitor (one turn = the visitor's message plus Henry's reply). */
  maxHistoryTurns: number;
  /** A visitor session idle this long is closed: its visit note is written and its history dropped. */
  idleMs: number;
  maxVisitors: number;
  /** Model turns allowed at once across every visitor (the brain is a local subscription CLI). */
  maxConcurrent: number;
  /** Turns allowed to wait for a slot before new ones are politely refused. */
  maxQueue: number;
  queueWaitMs: number;
  turnTimeoutMs: number;
  perVisitorPerMinute: number;
  perVisitorPerHour: number;
  perClientPerMinute: number;
  perClientPerHour: number;
  maxAudioBytes: number;
  maxAudioSeconds: number;
  /** Provider tried first for public turns. Claude by default: its no-tools lockdown is provable per run. */
  provider: ProviderName;
  /** Let a public turn fail over to the other (equally locked-down) CLI when the first is out of quota. */
  failover: boolean;
  tier: DispatchTier;
  /**
   * Model the FIRST-CHOICE public provider runs (HENRY_PUBLIC_MODEL; a failover CLI keeps its own
   * tier model). Claude defaults to "sonnet": measured 2026-09 it reaches first text faster than
   * haiku (the t0 model) on a public prompt, and naming it keeps a CLI default change from
   * silently moving the public face onto a slower model. "default" means the CLI's own default.
   */
  model?: string;
  /** Opening line shown and spoken on both faces; the default is generic. */
  opening?: string;
  /** Global cap on "ping the owner" messages per rolling hour. */
  pingsPerHour: number;
  /** Minimum gap between "a new visitor is chatting" notices to the owner. */
  noticeIntervalMs: number;
  /** Run one tool-less extraction turn when a visitor session closes. */
  summarise: boolean;
}

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function publicPackDir(dataDir: string): string {
  return path.join(dataDir, "public-pack", "published");
}

/** The fast model public Claude turns use unless HENRY_PUBLIC_MODEL or HENRY_PUBLIC_TIER says otherwise. */
export const DEFAULT_PUBLIC_CLAUDE_MODEL = "sonnet";

/** CLI model aliases and ids: letters, digits, dot, dash, underscore, colon, slash, brackets. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/[\]-]{0,63}$/;

function publicModel(value: string | undefined, provider: ProviderName, tier: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (trimmed) return trimmed.toLowerCase() === "default" || !MODEL_NAME.test(trimmed) ? undefined : trimmed;
  // An explicit tier choice means "that tier's model"; otherwise Claude gets the measured fast model.
  if (tier === "t0" || tier === "t2") return undefined;
  return provider === "claude" ? DEFAULT_PUBLIC_CLAUDE_MODEL : undefined;
}

export function publicModeConfig(config: Pick<HenryConfig, "dataDir">, env: NodeJS.ProcessEnv = process.env): PublicModeConfig {
  const tier = env.HENRY_PUBLIC_TIER === "t0" || env.HENRY_PUBLIC_TIER === "t2" ? env.HENRY_PUBLIC_TIER : "t1";
  const provider: ProviderName = env.HENRY_PUBLIC_PROVIDER === "codex" ? "codex" : "claude";
  return {
    packDir: publicPackDir(config.dataDir),
    maxPackBytes: int(env.HENRY_PUBLIC_PACK_MAX_BYTES, 60_000, 4_000, 200_000),
    maxMessageChars: int(env.HENRY_PUBLIC_MAX_MESSAGE_CHARS, 1_000, 100, 4_000),
    maxHistoryTurns: int(env.HENRY_PUBLIC_HISTORY_TURNS, 20, 1, 50),
    idleMs: int(env.HENRY_PUBLIC_IDLE_MINUTES, 15, 1, 240) * 60_000,
    maxVisitors: int(env.HENRY_PUBLIC_MAX_VISITORS, 500, 10, 10_000),
    maxConcurrent: int(env.HENRY_PUBLIC_MAX_CONCURRENT, 2, 1, 8),
    maxQueue: int(env.HENRY_PUBLIC_MAX_QUEUE, 4, 0, 50),
    queueWaitMs: int(env.HENRY_PUBLIC_QUEUE_WAIT_SECONDS, 25, 1, 300) * 1000,
    turnTimeoutMs: int(env.HENRY_PUBLIC_TURN_TIMEOUT_SECONDS, 120, 10, 600) * 1000,
    perVisitorPerMinute: int(env.HENRY_PUBLIC_VISITOR_PER_MINUTE, 6, 1, 120),
    perVisitorPerHour: int(env.HENRY_PUBLIC_VISITOR_PER_HOUR, 60, 1, 2_000),
    perClientPerMinute: int(env.HENRY_PUBLIC_CLIENT_PER_MINUTE, 12, 1, 240),
    perClientPerHour: int(env.HENRY_PUBLIC_CLIENT_PER_HOUR, 120, 1, 5_000),
    maxAudioBytes: int(env.HENRY_PUBLIC_MAX_AUDIO_BYTES, 2_000_000, 64_000, 8 * 1024 * 1024),
    maxAudioSeconds: int(env.HENRY_PUBLIC_MAX_AUDIO_SECONDS, 30, 3, 120),
    provider,
    failover: flag(env.HENRY_PUBLIC_FAILOVER, true),
    tier,
    model: publicModel(env.HENRY_PUBLIC_MODEL, provider, env.HENRY_PUBLIC_TIER),
    opening: env.HENRY_PUBLIC_OPENING?.trim() || undefined,
    pingsPerHour: int(env.HENRY_PUBLIC_PINGS_PER_HOUR, 5, 0, 100),
    noticeIntervalMs: int(env.HENRY_PUBLIC_NOTICE_MINUTES, 10, 0, 1_440) * 60_000,
    summarise: flag(env.HENRY_PUBLIC_SUMMARISE, true),
  };
}
