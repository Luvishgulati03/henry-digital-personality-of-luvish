import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ProviderEvent, ProviderName, RunResult } from "../types.ts";
import type { RunOptions } from "../providers/runner.ts";
import { finalClaudeResult, finalCodexAgentMessage } from "../providers/runner.ts";
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
  error?: string;
  limited?: boolean;
}

/** The final visible reply of a public run: Claude's result event, or Codex's last agent message. */
export function publicReplyText(provider: ProviderName, events: ProviderEvent[]): string {
  if (provider === "claude") return finalClaudeResult(events)?.response ?? "";
  return finalCodexAgentMessage(events) ?? "";
}

export async function runPublicModelTurn(
  runner: PublicRunner,
  mode: Pick<PublicModeConfig, "provider" | "failover" | "tier" | "turnTimeoutMs">,
  prompt: { system: string; user: string },
  options: { tier?: PublicModeConfig["tier"]; role?: string; cwd?: string; onEvent?: (event: ProviderEvent) => void } = {},
): Promise<PublicTurnResult> {
  const result = await runner.run(prompt.user, {
    publicTurn: { systemPrompt: prompt.system },
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
  return {
    reply: reply.trim(),
    provider: result.provider,
    durationMs: result.durationMs,
    ...(result.error ? { error: result.error } : {}),
    ...(result.limited ? { limited: true } : {}),
  };
}
