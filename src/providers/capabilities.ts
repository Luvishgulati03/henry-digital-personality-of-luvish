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

/**
 * Codex's curated Gmail app (plugin `gmail@openai-curated`, `.app.json` → this connector id).
 * The id is OpenAI's, not per-user, so the override below is portable.
 */
export const CODEX_GMAIL_APP_ID = "connector_2128aebfecb84f64a069897515042a44";
/** The Gmail app's delivering tools (all annotated openWorldHint: true in the Codex tool cache). */
export const CODEX_GMAIL_SEND_TOOLS = ["gmail.send_email", "gmail.send_draft", "gmail.forward_emails"];

/**
 * `-c` overrides that make a VOICE-TURN Codex run unable to send, whatever the prompt says.
 *
 * - Every Codex app (connector) loses its open-world and destructive tools — `_default` for all
 *   apps, and the Gmail app explicitly (a per-app table would otherwise shadow `_default`). In the
 *   Gmail app every sending tool is open-world and every read tool is not, so reads and drafts keep
 *   working while send/forward/delete are gone. The three send tools are also disabled by name, so
 *   the rail does not rest on annotations alone.
 * - Any user-defined MCP server whose name mentions mail is disabled outright: Henry cannot know
 *   its tool names (e.g. a local gmail MCP exposing send_email), so it fails closed. Only servers
 *   that actually exist in the user's config.toml are named — Codex rejects an override that
 *   creates a server table with no transport.
 * - HENRY_VOICE_TURN=1 is pinned into the shell environment policy, so the model's shell commands
 *   (and every `henry …` they run) carry the flag even under a restrictive `inherit` setting.
 */
export function codexVoiceTurnOverrides(codexConfigToml = ""): string[] {
  const app = `apps.${CODEX_GMAIL_APP_ID}`;
  const overrides = [
    "apps._default.open_world_enabled=false",
    "apps._default.destructive_enabled=false",
    `${app}.open_world_enabled=false`,
    `${app}.destructive_enabled=false`,
    ...CODEX_GMAIL_SEND_TOOLS.map((tool) => `${app}.tools."${tool}".enabled=false`),
    ...codexMailServers(codexConfigToml).map((name) => `mcp_servers.${/^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)}.enabled=false`),
    'shell_environment_policy.set.HENRY_VOICE_TURN="1"',
  ];
  return overrides.flatMap((override) => ["-c", override]);
}

/** Names of `[mcp_servers.<name>]` tables in a Codex config.toml whose name mentions mail. */
export function codexMailServers(codexConfigToml: string): string[] {
  const names = new Set<string>();
  for (const match of codexConfigToml.matchAll(/^\s*\[mcp_servers\.(?:"([^"]+)"|([A-Za-z0-9_-]+))\]\s*$/gm)) {
    const name = match[1] ?? match[2];
    if (name && /mail/i.test(name)) names.add(name);
  }
  return [...names];
}

/** Claude Gmail tools that deliver mail, from the cached headless init proof. Denied on voice turns. */
export function claudeGmailSendTools(capability: ConnectorCapability | undefined): string[] {
  return (capability?.tools ?? []).filter((tool) => GMAIL_SEND.test(tool));
}
