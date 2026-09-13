import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ProviderEvent } from "../types.ts";

/**
 * Connector capabilities per provider CLI — "can this CLI actually reach Gmail right now?".
 *
 * Codex's Gmail connector is Henry's long-standing default and is assumed present. Claude's is
 * PROVEN per machine: every headless Claude run that streams JSON opens with a `system/init`
 * event listing its MCP servers (with auth status) and tool names, and that evidence is cached
 * in `data/provider-capabilities.json`. A Gmail run may only fail over to Claude when that
 * evidence says the connector is connected — a model without the tool would otherwise answer
 * "no matching mail", and mailwatch would believe it.
 *
 * Interactive `claude mcp list` can report a claude.ai connector as connected while headless
 * `claude -p` still sees `needs-auth`; only the headless init event counts here.
 */

export type ConnectorName = "gmail";
export type GmailAccess = "read" | "draft";

export const CAPABILITY_FILE = "provider-capabilities.json";

export interface ConnectorCapability {
  /** MCP server status from the init event: "connected", "needs-auth", "pending", "failed", or "absent". */
  status: string;
  /** Every tool name the connector exposed on that run. */
  tools: string[];
  checkedAt: string;
}

export interface CapabilityState {
  claude?: { gmail?: ConnectorCapability };
}

/** Gmail tools that change the mailbox. Anything matching is never allowed on a read-only run. */
const GMAIL_WRITE = /send|draft|create|modify|update|delete|trash|label|archive|batch|move|mark|remove|forward|reply/i;
/** Draft-creating tools, allowed only on a drafting run. */
const GMAIL_DRAFT = /draft/i;
/** Tools that deliver mail. Never allowed on a fallback run — sends are Codex-pinned and approval-gated. */
const GMAIL_SEND = /send|forward|reply/i;

export function readCapabilities(filePath: string): CapabilityState {
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as CapabilityState : {};
  } catch {
    return {};
  }
}

function writeCapabilities(filePath: string, state: CapabilityState): void {
  try {
    mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true, mode: 0o700 });
    writeFileSync(filePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // A read-only data dir leaves Claude unproven, which fails closed for Gmail runs.
  }
}

/** The `system/init` event a stream-json Claude run opens with, if the run got that far. */
export function claudeInitEvent(events: ProviderEvent[]): Record<string, unknown> | undefined {
  return events.find((event) => event.parsed?.type === "system" && event.parsed?.subtype === "init")?.parsed;
}

/**
 * Caches what one Claude run proved about its Gmail connector. Returns the recorded capability,
 * or undefined when the run carried no init event (plain-text runs never do).
 */
export function recordClaudeInit(filePath: string, events: ProviderEvent[], now: Date = new Date()): ConnectorCapability | undefined {
  const init = claudeInitEvent(events);
  if (!init) return undefined;
  const servers = Array.isArray(init.mcp_servers) ? init.mcp_servers as Array<{ name?: unknown; status?: unknown }> : [];
  const server = servers.find((entry) => typeof entry.name === "string" && /gmail/i.test(entry.name));
  const tools = (Array.isArray(init.tools) ? init.tools : [])
    .filter((tool): tool is string => typeof tool === "string" && tool.startsWith("mcp__") && /gmail/i.test(tool));
  const capability: ConnectorCapability = {
    status: typeof server?.status === "string" ? server.status : "absent",
    tools,
    checkedAt: now.toISOString(),
  };
  const state = readCapabilities(filePath);
  writeCapabilities(filePath, { ...state, claude: { ...state.claude, gmail: capability } });
  return capability;
}

/**
 * The exact Gmail tool allow/deny lists for a Claude run, or undefined when the connector is not
 * proven usable (not connected, or it exposes no read tool). Read access gets only non-mutating
 * tools; draft access adds draft tools. Send-capable tools are always denied.
 */
export function gmailToolAccess(
  capability: ConnectorCapability | undefined,
  access: GmailAccess,
): { allowed: string[]; denied: string[] } | undefined {
  if (!capability || capability.status !== "connected") return undefined;
  const read = capability.tools.filter((tool) => !GMAIL_WRITE.test(tool));
  if (!read.length) return undefined;
  const drafts = access === "draft" ? capability.tools.filter((tool) => GMAIL_DRAFT.test(tool) && !GMAIL_SEND.test(tool)) : [];
  const allowed = [...read, ...drafts];
  return { allowed, denied: capability.tools.filter((tool) => !allowed.includes(tool)) };
}

/** Operator-facing reason Claude was not used for a Gmail run. */
export function describeClaudeGmail(capability: ConnectorCapability | undefined): string {
  const state = capability ? `reported ${capability.status} at ${capability.checkedAt}` : "has never been checked";
  return `Claude's Gmail connector ${state}. Authorize it for headless runs (run \`claude\`, open /mcp, authenticate claude.ai Gmail), then run \`henry provider check\`.`;
}
