import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderEvent, ProviderName, RunResult } from "../types.ts";
import type { RunOptions } from "../providers/runner.ts";
import { ENVELOPE_TIMEOUT_ERROR, finalClaudeResult, finalCodexAgentMessage } from "../providers/runner.ts";
import type { PublicModeConfig } from "./config.ts";

/**
 * One public model turn through Henry's own ProviderRunner (subscription CLI, failover intact), in
 * the public sandbox (src/providers/public-sandbox.ts). The caller supplies the already-built
 * system and user halves (src/public/prompt.ts); this file owns the spawn options and pulls out the
 * final visible reply. It never touches memory, approvals, connectors, or sessions.
 */

export type PublicRunner = { run(prompt: string, options: RunOptions): Promise<RunResult> };

let scratchDirCache: string | undefined;

/**
 * An EMPTY directory outside the repository, created once per process (0700). Public turns run
 * here so neither CLI discovers the repo's CLAUDE.md/AGENTS.md by walking up from its cwd, and the
 * default working directory holds nothing to read even if a tool ever appeared.
 */
export function publicScratchDir(): string {
  if (scratchDirCache && fs.existsSync(scratchDirCache)) return scratchDirCache;
  scratchDirCache = fs.mkdtempSync(path.join(os.tmpdir(), "henry-public-"));
  fs.chmodSync(scratchDirCache, 0o700);
  return scratchDirCache;
}

export interface PublicTurnResult {
  reply: string;
  provider: ProviderName;
  durationMs: number;
  /** The model that answered, as the CLI reported it (Claude's init event), else the one requested. */
  model?: string;
  /** Milliseconds from spawn to the first visible text (the runner's phase timing). */
  firstTextMs?: number | null;
  timedOut?: boolean;
  error?: string;
  limited?: boolean;
}

/** The final visible reply of a public run: Claude's result event, or Codex's last agent message. */
export function publicReplyText(provider: ProviderName, events: ProviderEvent[]): string {
  if (provider === "claude") return finalClaudeResult(events)?.response ?? "";
  return finalCodexAgentMessage(events) ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * What one provider event means for a STREAMED public reply:
 *   start  a provider attempt began (Claude's init event, Codex's thread.started). Anything
 *          streamed before it belonged to an earlier attempt (a failover) and must be dropped.
 *   text   visible reply text: a Claude text delta (--include-partial-messages), or a whole Codex
 *          agent message (Codex's JSON stream carries no deltas).
 * Everything else (thinking, tool blocks, usage, stderr) is not visible text.
 */
export function publicStreamEvent(event: ProviderEvent): { kind: "start" } | { kind: "text"; text: string } | undefined {
  const parsed = event.parsed;
  if (event.stream !== "stdout" || !isRecord(parsed)) return undefined;
  if ((parsed.type === "system" && parsed.subtype === "init") || parsed.type === "thread.started") return { kind: "start" };
  if (parsed.type === "stream_event" && isRecord(parsed.event) && parsed.event.type === "content_block_delta") {
    const delta = parsed.event.delta;
    if (isRecord(delta) && delta.type === "text_delta" && typeof delta.text === "string" && delta.text) return { kind: "text", text: delta.text };
    return undefined;
  }
  if (parsed.type === "item.completed" && isRecord(parsed.item) && parsed.item.type === "agent_message" && typeof parsed.item.text === "string" && parsed.item.text.trim()) {
    return { kind: "text", text: parsed.item.text };
  }
  return undefined;
}

/** The model Claude's init event reports for the run, if any. */
function reportedModel(events: ProviderEvent[]): string | undefined {
  for (const event of events) {
    const parsed = event.parsed;
    if (isRecord(parsed) && parsed.type === "system" && parsed.subtype === "init" && typeof parsed.model === "string") return parsed.model;
  }
  return undefined;
}

export async function runPublicModelTurn(
  runner: PublicRunner,
  mode: Pick<PublicModeConfig, "provider" | "failover" | "tier" | "turnTimeoutMs"> & { model?: string },
  prompt: { system: string; user: string },
  options: {
    tier?: PublicModeConfig["tier"]; role?: string; cwd?: string; onEvent?: (event: ProviderEvent) => void;
    /** Overrides mode.model; null runs the tier's model (the visit-summary turn). */
    model?: string | null;
  } = {},
): Promise<PublicTurnResult> {
  const model = options.model === null ? undefined : options.model ?? mode.model;
  const result = await runner.run(prompt.user, {
    publicTurn: { systemPrompt: prompt.system, ...(model ? { models: { [mode.provider]: model } } : {}) },
    provider: mode.provider,
    // "soft": a public turn may move to the other CLI when the first is out of quota (both run
    // the same lockdown); "hard" keeps it on the configured provider only.
    pin: mode.failover ? "soft" : "hard",
    cwd: options.cwd ?? publicScratchDir(),
    tier: options.tier ?? mode.tier,
    timeoutMs: mode.turnTimeoutMs,
    role: options.role ?? "public",
    readOnly: true,
    ...(options.onEvent ? { onEvent: options.onEvent } : {}),
  });
  // Only the final message counts. The plain `response` is a fallback solely for a run that
  // produced no structured events at all (it would otherwise include Codex reasoning text).
  const structured = result.events.some((event) => event.parsed);
  const reply = result.error ? "" : structured ? publicReplyText(result.provider, result.events) : result.exitCode === 0 ? result.response : "";
  const answeredModel = reportedModel(result.events) ?? (result.provider === mode.provider ? model : undefined);
  return {
    reply: reply.trim(),
    provider: result.provider,
    durationMs: result.durationMs,
    ...(answeredModel ? { model: answeredModel } : {}),
    firstTextMs: result.firstTextMs ?? null,
    ...(result.error === ENVELOPE_TIMEOUT_ERROR ? { timedOut: true } : {}),
    ...(result.error ? { error: result.error } : {}),
    ...(result.limited ? { limited: true } : {}),
  };
}
