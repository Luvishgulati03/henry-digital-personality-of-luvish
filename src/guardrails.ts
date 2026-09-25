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
  if (isVoiceTurn(env)) throw new Error(VOICE_TURN_REFUSAL);
}

/**
 * The dashboard process itself never carries HENRY_VOICE_TURN, but a voice turn's child can reach
 * it over loopback (curl to /api/approvals/…, or a typed-looking "approve <id>" to /api/chat/send).
 * While a voice turn is in flight the dashboard refuses those with this message.
 */
export const VOICE_TURN_IN_FLIGHT_REFUSAL =
  "Approvals and outbound sends are disabled while a voice turn is running. Approve by typing in the dashboard or Telegram once it finishes.";
