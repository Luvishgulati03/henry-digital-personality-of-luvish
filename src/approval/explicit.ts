import type { ApprovalItem } from "../types.ts";

type ExplicitApprovalRuntime = {
  approvals: { list(status?: ApprovalItem["status"]): Promise<ApprovalItem[]> };
  approve(id: string): Promise<void>;
  executeApproval(id: string): Promise<string>;
};

/** Local approval grammar: `APPROVE <UUID>` or `APPROVE: <exact staged body>`. */
export function explicitApprovalTarget(input: string): { id?: string; body?: string } | undefined {
  const text = input.trim();
  const byId = text.match(/^(?:i\s+)?(?:explicitly\s+)?approve\s+([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\s*[.!]?$/i);
  if (byId) return { id: byId[1] };
  const byBody = text.match(/^(?:i\s+)?(?:explicitly\s+)?approve\s*:\s*(.+?)\s*[.!]?$/is);
  if (!byBody) return undefined;
  const body = byBody[1].trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
  return body ? { body } : undefined;
}

/** Run only after a local human supplied an exact approval command. */
export async function executeExplicitApproval(runtime: ExplicitApprovalRuntime, input: string): Promise<string | undefined> {
  const target = explicitApprovalTarget(input);
  if (!target) return undefined;
  const pending = await runtime.approvals.list("pending");
  const matches = target.id
    ? pending.filter((candidate) => candidate.id === target.id)
    : pending.filter((candidate) => candidate.body.trim() === target.body);
  if (!matches.length) return "No pending action matches that exact approval.";
  if (matches.length > 1) return "That text matches more than one pending action; approve by its ID instead.";
  await runtime.approve(matches[0].id);
  return runtime.executeApproval(matches[0].id);
}
