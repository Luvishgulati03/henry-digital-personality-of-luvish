import type { ApprovalItem } from "./types.ts";

/**
 * Prompts guide the model; the approval state check below is the enforcement
 * boundary for outbound actions.
 */
export const OUTBOUND_EMAIL_APPROVAL_GUARDRAIL =
  "Never send or reply to an email without Luvish's explicit approval. Drafting and saving are allowed; sending requires a separate approval action first.";

/**
 * Outbound integrations may only run after Henry atomically claims an action
 * that was already approved. Pending or merely proposed actions never reach
 * Gmail or GitHub.
 */
export function assertOutboundExecutionClaim(
  item: Pick<ApprovalItem, "kind" | "status">,
): void {
  assertNotVoiceTurn();
  if (item.status === "executing") return;
  throw new Error(
    `Blocked outbound action: ${item.kind} requires Luvish's explicit approval before execution (status: ${item.status})`,
  );
}

/**
 * The voice rail, enforced in code. A voice-originated turn runs its provider child with
 * HENRY_VOICE_TURN=1 (src/providers/runner.ts), and every process that child starts
 * inherits it — including `henry approve …`, `henry remind --execute-approval …`, and a
 * grandchild provider run. Anything that would approve, claim, execute, or send an
 * outbound action calls `assertNotVoiceTurn()` first. Reading, drafting, and staging a
 * pending approval stay allowed.
 */
export const VOICE_TURN_ENV = "HENRY_VOICE_TURN";

export const VOICE_TURN_REFUSAL =
  "Approvals and outbound sends are disabled during a voice turn. Approve by typing in the dashboard or Telegram.";

export function isVoiceTurn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[VOICE_TURN_ENV] === "1";
}

export function assertNotVoiceTurn(env: NodeJS.ProcessEnv = process.env): void {
  // The public rail is stricter than the voice rail, so every voice refusal point refuses a
  // public turn too (approvals, claims, executions, sends, reminders, tweets, standups).
  if (isPublicTurn(env)) throw new Error(PUBLIC_TURN_REFUSAL);
  if (isVoiceTurn(env)) throw new Error(VOICE_TURN_REFUSAL);
}

/**
 * The public rail. A turn answering an anonymous visitor on Henry's public face (src/public/)
 * runs its provider child with HENRY_PUBLIC_TURN=1 on top of having no tools at all. Every path
 * that refuses a voice turn (assertNotVoiceTurn, isRestrictedTurn) refuses this one too, so even a
 * provider regression that handed the model a shell could not approve, claim, execute, or send.
 */
export const PUBLIC_TURN_ENV = "HENRY_PUBLIC_TURN";

export const PUBLIC_TURN_REFUSAL =
  "Approvals, sends, and every other owner action are disabled during a public visitor turn.";

export function isPublicTurn(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[PUBLIC_TURN_ENV] === "1";
}

/** True for any turn that must never approve or send: a voice turn or a public visitor turn. */
export function isRestrictedTurn(env: NodeJS.ProcessEnv = process.env): boolean {
  return isVoiceTurn(env) || isPublicTurn(env);
}

/**
 * The dashboard process itself never carries HENRY_VOICE_TURN, but a voice turn's child can reach
 * it over loopback (curl to /api/approvals/…, or a typed-looking "approve <id>" to /api/chat/send).
 * While a voice turn is in flight the dashboard refuses those with this message.
 */
export const VOICE_TURN_IN_FLIGHT_REFUSAL =
  "Approvals and outbound sends are disabled while a voice turn is running. Approve by typing in the dashboard or Telegram once it finishes.";
