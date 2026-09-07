import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import {
  DraftRepliesService,
  matchReplySource,
  normalizeSubjectKey,
  parseDraftedLine,
  parseDraftBlocks,
  type DraftRepliesNotifier,
} from "../src/gmail-drafts/service.ts";
import type { ProviderRunner } from "../src/providers/runner.ts";
import type { RunResult } from "../src/types.ts";

async function setup(): Promise<{ config: ReturnType<typeof loadConfig>; activity: ActivityLog }> {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-draftreplies-"));
  const config = loadConfig(rootDir);
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  return { config, activity };
}

function fakeRunner(response: string): ProviderRunner {
  return {
    run: async (): Promise<RunResult> => ({
      runId: "r1", provider: "codex", response, exitCode: 0, durationMs: 1, events: [],
    }),
  } as unknown as ProviderRunner;
}

function fakeNotifier(): { notify: DraftRepliesNotifier; messages: Array<{ message: string; title?: string }> } {
  const messages: Array<{ message: string; title?: string }> = [];
  const notify: DraftRepliesNotifier = async (message, title) => { messages.push({ message, title }); };
  return { notify, messages };
}

test("parseDraftedLine parses well-formed DRAFTED lines and rejects garbage", () => {
  const good = parseDraftedLine("DRAFTED|jane@acme.com|Re: Contract review|Hey Jane, thanks for sending this over");
  assert.deepEqual(good, {
    to: "jane@acme.com", subject: "Re: Contract review", preview: "Hey Jane, thanks for sending this over",
  });
  assert.equal(parseDraftedLine("NO_REPLIES_NEEDED"), undefined);
  assert.equal(parseDraftedLine(""), undefined);
  assert.equal(parseDraftedLine("just some prose the model emitted"), undefined);
  assert.equal(parseDraftedLine("DRAFTED|only|two"), undefined);
  assert.equal(parseDraftedLine("DRAFTED||subject|preview"), undefined); // missing "to"
  assert.equal(parseDraftedLine("DRAFTED|to|subject|"), undefined); // missing preview
});

test("parseDraftBlocks extracts full DRAFT_BEGIN/DRAFT_END bodies and ignores malformed ones", () => {
  const response = [
    "DRAFT_BEGIN",
    "To: jane@acme.com",
    "Subject: Re: Contract review",
    "Body:",
    "Hey Jane,",
    "",
    "Looks good, one flag: [confirm the effective date].",
    "DRAFT_END",
    "some stray prose",
    "DRAFT_BEGIN",
    "To: bob@foo.com",
    "not a real block",
  ].join("\n");
  const blocks = parseDraftBlocks(response);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].to, "jane@acme.com");
  assert.equal(blocks[0].subject, "Re: Contract review");
  assert.ok(blocks[0].body.includes("[confirm the effective date]"));
});

test("reply source matching is deterministic and never trusts a model-supplied identifier", () => {
  assert.equal(normalizeSubjectKey("Re: RE: Contract review"), "contract review");
  const source = matchReplySource(
    { to: "Jane Doe <JANE@example.com>", subject: "Re: Contract review" },
    [
      { id: "newer", from: "Jane <jane@example.com>", subject: "Different topic" },
      { id: "matching", from: "Jane <jane@example.com>", subject: "Contract review", messageId: "<parent>" },
    ],
  );
  assert.equal(source?.id, "matching");
  assert.equal(matchReplySource({ to: "unknown@example.com", subject: "Contract review" }, []), undefined);
});

test("draftReplies() parses drafts, notifies, records activity, and writes the local markdown file", async () => {
  const { config, activity } = await setup();
  const response = [
    "DRAFT_BEGIN",
    "To: jane@acme.com",
    "Subject: Re: Contract review",
    "Body:",
    "Hey Jane, thanks for sending this over — looks good, one flag on the effective date.",
    "DRAFT_END",
    "DRAFTED|jane@acme.com|Re: Contract review|Hey Jane, thanks for sending this over — looks good",
    "some stray line the model should not have emitted",
  ].join("\n");
  const { notify, messages } = fakeNotifier();
  const service = new DraftRepliesService(config, activity, fakeRunner(response), notify);

  const result = await service.draftReplies(5);
  assert.equal(result.drafted.length, 1);
  assert.equal(result.drafted[0].to, "jane@acme.com");
  assert.equal(result.skipped, 0);
  assert.deepEqual(result.staged, []);
  assert.ok(result.localPath.startsWith(config.draftRepliesDir));

  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, "Henry — email drafts");
  assert.match(messages[0].message, /Drafted 1 replies/);

  const fileContents = await fs.readFile(result.localPath, "utf8");
  assert.match(fileContents, /Re: Contract review/);
  assert.match(fileContents, /jane@acme\.com/);
  assert.match(fileContents, /looks good, one flag on the effective date/);

  const events = await activity.list(50);
  const draftEvents = events.filter((e) => e.kind === "gmail.drafted");
  assert.equal(draftEvents.length, 1);
  assert.equal(draftEvents[0].metadata?.count, 1);
});

test("draftReplies() counts malformed DRAFTED| lines as skipped without throwing", async () => {
  const { config, activity } = await setup();
  const response = [
    "DRAFTED|only|two",
    "DRAFTED|jane@acme.com|Re: hi|A real preview here",
  ].join("\n");
  const service = new DraftRepliesService(config, activity, fakeRunner(response));
  const result = await service.draftReplies(5);
  assert.equal(result.drafted.length, 1);
  assert.equal(result.skipped, 1);
});

test("opt-in reply threading stages matched RFC identity for explicit approval", async () => {
  const { config, activity } = await setup();
  const response = [
    "DRAFT_BEGIN",
    "To: jane@example.com",
    "Subject: Re: Contract review",
    "Body:",
    "Thanks — I will review it.",
    "DRAFT_END",
    "DRAFTED|jane@example.com|Re: Contract review|Thanks — I will review it.",
  ].join("\n");
  const stagedInputs: Array<{ to: string; subject: string; body: string; threadId?: string; inReplyTo?: string; references?: string }> = [];
  const service = new DraftRepliesService(config, activity, fakeRunner(response), undefined, {
    readSources: async () => [{
      id: "message-id", threadId: "thread-id", messageId: "<parent@example.com>",
      references: "<root@example.com>", from: "Jane <jane@example.com>", subject: "Contract review",
    }],
    stage: async (input) => { stagedInputs.push(input); return { id: "approval-id" }; },
  });

  const result = await service.draftReplies(5);
  assert.deepEqual(result.staged, [{
    approvalId: "approval-id", to: "jane@example.com", subject: "Re: Contract review",
    threadId: "thread-id", inReplyTo: "<parent@example.com>", unthreaded: false,
  }]);
  assert.deepEqual(stagedInputs, [{
    to: "jane@example.com", subject: "Re: Contract review", body: "Thanks — I will review it.",
    threadId: "thread-id", inReplyTo: "<parent@example.com>", references: "<root@example.com>",
  }]);
});

test("draftReplies() handles NO_REPLIES_NEEDED with an empty drafted array and no notification", async () => {
  const { config, activity } = await setup();
  const { notify, messages } = fakeNotifier();
  const service = new DraftRepliesService(config, activity, fakeRunner("NO_REPLIES_NEEDED"), notify);
  const result = await service.draftReplies(5);
  assert.deepEqual(result.drafted, []);
  assert.equal(result.skipped, 0);
  assert.equal(messages.length, 0);
  const fileContents = await fs.readFile(result.localPath, "utf8");
  assert.match(fileContents, /No replies were needed today/);
});
