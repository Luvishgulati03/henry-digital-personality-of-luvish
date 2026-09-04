import test from "node:test";
import assert from "node:assert/strict";
import { explicitApprovalTarget, executeExplicitApproval } from "../src/approval/explicit.ts";
import type { ApprovalItem } from "../src/types.ts";

const item: ApprovalItem = {
  id: "12345678-1234-1234-1234-123456789abc", createdAt: "", updatedAt: "", kind: "social.x-post", status: "pending",
  title: "Post to X", body: "bengaluru weather>>>>", payload: { text: "bengaluru weather>>>>" },
};

test("explicit approvals require an ID or exact staged body", () => {
  assert.deepEqual(explicitApprovalTarget("APPROVE 12345678-1234-1234-1234-123456789abc"), { id: item.id });
  assert.deepEqual(explicitApprovalTarget("I explicitly approve: bengaluru weather>>>>"), { body: item.body });
  assert.equal(explicitApprovalTarget("approve it"), undefined);
});

test("an exact local approval records approval then executes", async () => {
  const calls: string[] = [];
  const result = await executeExplicitApproval({
    approvals: { list: async () => [item] },
    approve: async (id) => { calls.push(`approve:${id}`); },
    executeApproval: async (id) => { calls.push(`execute:${id}`); return "Posted to X"; },
  }, "APPROVE: bengaluru weather>>>>");
  assert.equal(result, "Posted to X");
  assert.deepEqual(calls, [`approve:${item.id}`, `execute:${item.id}`]);
});
