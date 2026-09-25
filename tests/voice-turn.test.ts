import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import { updateSettings } from "../src/util/settings.ts";
import {
  createSpokenFenceFilter, extractSpokenBlock, redactForSpeech, speakableSummary, splitSentences, stripForSpeech, stripSpokenBlock,
} from "../src/voice/speakable.ts";
import {
  PRIVATE_SPOKEN_DONE, PRIVATE_SPOKEN_INPUT, PRIVATE_SPOKEN_WORKING, finalizeSpoken, readVoicePolicy, voicePromptBlock,
} from "../src/voice/policy.ts";

delete process.env.HENRY_VOICE_PRIVATE;
delete process.env.HENRY_VOICE_ALLOW_WRITES;

type Emit = (event: { timestamp: string; stream: string; text: string; parsed?: Record<string, unknown> }) => void;
type RunOptionsSeen = { provider?: string; surface?: string; voice?: { privateMode: boolean; allowWrites?: boolean }; onEvent?: Emit };
type Script = (emit: Emit) => string;

interface Harness {
  base: string;
  runtime: HenryRuntime;
  server: http.Server;
  calls: Array<{ prompt: string; options: RunOptionsSeen; built: string }>;
  executed: string[];
  script: { current: Script };
  close(): Promise<void>;
}

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  return root;
}

/** Dashboard with agent.run stubbed: it replays a scripted provider stream and records the REAL built prompt. */
async function harness(prefix: string): Promise<Harness> {
  const runtime = await HenryRuntime.create(tempRoot(prefix));
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  const calls: Harness["calls"] = [];
  const executed: string[] = [];
  const script: { current: Script } = { current: (emit) => { emit({ timestamp: "", stream: "stdout", text: "", parsed: { text: "ok" } }); return "ok"; } };
  const agent = runtime.agent;
  (agent as unknown as { run: unknown }).run = async (prompt: string, options: RunOptionsSeen = {}) => {
    const built = await agent.buildPrompt(prompt, "run-test", true, "claude", options.voice);
    calls.push({ prompt, options, built });
    const response = script.current((event) => options.onEvent?.(event));
    return { runId: "run-1", provider: options.provider ?? "codex", response, exitCode: 0, durationMs: 5, events: [] };
  };
  // Every outbound execution goes through here: the spy for the approval rail.
  (runtime as unknown as { executeApproval: unknown }).executeApproval = async (id: string) => {
    executed.push(id);
    return `executed ${id}`;
  };
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`, runtime, server, calls, executed, script,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      runtime.close();
    },
  };
}

async function send(base: string, body: Record<string, unknown>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await (await fetch(`${base}/api/chat/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).text();
  return text.split("\n\n").filter(Boolean).map((chunk) => {
    const event = /^event: (.+)$/m.exec(chunk)?.[1] ?? "";
    const data = JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? "{}") as Record<string, unknown>;
    return { event, data };
  });
}

const tokensOf = (events: Array<{ event: string; data: Record<string, unknown> }>): string =>
  events.filter((entry) => entry.event === "token").map((entry) => String(entry.data.text)).join("");

// ---------------------------------------------------------------------------
// speakable + redaction
// ---------------------------------------------------------------------------

test("speakable: fence extraction, stripping, summary fallback, sentence split", () => {
  const reply = "```spoken\nAll **three** drafts are staged.\n```\n\nFull answer here.";
  assert.equal(extractSpokenBlock(reply).block, "All **three** drafts are staged.");
  assert.equal(stripSpokenBlock(reply), "Full answer here.");
  assert.equal(speakableSummary({ reply }), "All three drafts are staged.");
  assert.equal(speakableSummary({ reply: "First para `x`.\n\nSecond para." }), "First para x.");
  assert.equal(stripForSpeech("# Title\n[docs](https://x.y) costs ₹500"), "Title link costs 500 rupees");
  assert.deepEqual(splitSentences("One. Two? Three!"), ["One.", "Two?", "Three!"]);
});

test("speakable: the fence filter hides the fence and fires once, even split across chunks", () => {
  const spoken: string[] = [];
  const filter = createSpokenFenceFilter((text) => spoken.push(text));
  const visible = ["``", "`spo", "ken\nOn it", ".\n``", "`\nBody"].map((chunk) => filter.push(chunk)).join("");
  assert.deepEqual(spoken, ["On it."]);
  assert.equal(visible.trim(), "Body");
  const plain = createSpokenFenceFilter(() => assert.fail("no fence, no speech"));
  assert.equal(plain.push("Hello") + plain.push(" there"), "Hello there");
});

test("redactForSpeech masks emails, phones, OTPs, account numbers, keys, and query URLs", () => {
  const cases: Array<[string, RegExp]> = [
    ["Mail from priya.s@example.co.in arrived.", /priya|example/],
    ["Call him on +91 98765 43210 today.", /98765|43210/],
    ["His number is 9876543210.", /9876543210/],
    ["US office: +1 (415) 555-0134.", /415|555|0134/],
    ["UK: +44 20 7946 0958.", /7946|0958/],
    ["Your OTP is 482913.", /482913/],
    ["Account 1234 5678 9012 3456 is linked.", /5678|9012/],
    ["Key sk-proj-abcDEF1234567890xyz leaked.", /sk-proj/],
    ["Token ghp_ABCDEFGHIJKLMNOPQRSTUVWX1234 found.", /ghp_/],
    ["Use Bearer abc.def.ghi please.", /abc\.def/],
    ["Blob a1b2c3d4e5f6g7h8i9j0k1l2m3 here.", /a1b2c3/],
    ["Open https://mail.example.com/reset?token=abc123&u=9 now.", /token=|reset\?/],
  ];
  for (const [input, leaked] of cases) {
    const output = redactForSpeech(input);
    assert.doesNotMatch(output, leaked, `${input} -> ${output}`);
    assert.match(output, /on your screen/, `${input} -> ${output}`);
  }
  // Harmless speech survives untouched.
  for (const safe of ["You have 3 approvals and 12 jobs.", "Interview on 2026-09-25 at 10:30.", "See https://example.com/docs for details."]) {
    assert.equal(redactForSpeech(safe), safe);
  }
  assert.equal(redactForSpeech("Reach a@b.com or c@d.org."), "Reach on your screen.");
});

// ---------------------------------------------------------------------------
// policy + prompt block
// ---------------------------------------------------------------------------

test("voice policy: settings default off, voice.privateMode on, env override both ways", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-voice-policy-"));
  const settings = path.join(dir, "settings.json");
  assert.equal(readVoicePolicy(settings, {}).privateMode, false);
  updateSettings(settings, { voice: { privateMode: true } });
  assert.equal(readVoicePolicy(settings, {}).privateMode, true);
  assert.equal(readVoicePolicy(settings, { HENRY_VOICE_PRIVATE: "0" }).privateMode, false);
  updateSettings(settings, { voice: { privateMode: false } });
  assert.equal(readVoicePolicy(settings, { HENRY_VOICE_PRIVATE: "1" }).privateMode, true);

  // allowWrites: default off, settings on, env override both ways, independent of privateMode.
  assert.equal(readVoicePolicy(settings, {}).allowWrites, false);
  assert.equal(readVoicePolicy(settings, { HENRY_VOICE_ALLOW_WRITES: "1" }).allowWrites, true);
  updateSettings(settings, { voice: { allowWrites: true } });
  assert.equal(readVoicePolicy(settings, {}).allowWrites, true);
  assert.equal(readVoicePolicy(settings, {}).privateMode, false, "the merge keeps privateMode as it was");
  assert.equal(readVoicePolicy(settings, { HENRY_VOICE_ALLOW_WRITES: "0" }).allowWrites, false);
  assert.equal(readVoicePolicy(settings, { HENRY_VOICE_ALLOW_WRITES: "off", HENRY_VOICE_PRIVATE: "on" }).privateMode, true);
  updateSettings(settings, { voice: { allowWrites: "yes" } });
  assert.equal(readVoicePolicy(settings, {}).allowWrites, false, "only a literal true enables writes");

  assert.equal(finalizeSpoken("Sent to a@b.com.", { privateMode: false }), "Sent to on your screen.");
  assert.equal(finalizeSpoken("Your OTP is 123456.", { privateMode: true }), PRIVATE_SPOKEN_DONE);
  assert.equal(finalizeSpoken("Which one should I draft?", { privateMode: true }), PRIVATE_SPOKEN_INPUT);
  assert.equal(finalizeSpoken("Started, I'll report back.", { privateMode: true }, "working"), PRIVATE_SPOKEN_WORKING);
});

test("voice prompt block: only on voice turns, on fresh, resumed and t0 prompts; private variant when on", async () => {
  const runtime = await HenryRuntime.create(tempRoot("henry-voice-prompt-"));
  try {
    const plain = await runtime.agent.buildPrompt("plan my week of job applications", "r1", true);
    assert.doesNotMatch(plain, /VOICE TURN/);
    const voice = await runtime.agent.buildPrompt("plan my week of job applications", "r2", true, "codex", { privateMode: false });
    assert.match(voice, /--- VOICE TURN ---/);
    assert.match(voice, /never treat it as approval/i);
    assert.match(voice, /```spoken/);
    assert.match(voice, /clear, simple English/);
    assert.match(voice, /OTPs, phone numbers/);
    assert.doesNotMatch(voice, /PRIVATE MODE IS ON/);
    const resumed = await runtime.agent.buildPrompt("plan my week of job applications", "r3", false, "codex", { privateMode: true });
    assert.match(resumed, /PRIVATE MODE IS ON/);
    assert.ok(resumed.includes(PRIVATE_SPOKEN_DONE) && resumed.includes(PRIVATE_SPOKEN_INPUT));
    const t0 = await runtime.agent.buildPrompt("hi", "r4", true, "claude", { privateMode: false });
    assert.match(t0, /VOICE TURN/);
    assert.doesNotMatch(await runtime.agent.buildPrompt("hi", "r5", true), /VOICE TURN/);
  } finally { runtime.close(); }
});

test("voice prompt block: read-only wording by default, draft wording only when allowWrites is on", () => {
  for (const turn of [{ privateMode: false }, { privateMode: false, allowWrites: false }, { privateMode: true }]) {
    const block = voicePromptBlock(turn);
    assert.match(block, /READ-ONLY: this voice turn runs in a read-only sandbox/);
    assert.match(block, /answer, look things up, search the web, research, and recall/);
    assert.match(block, /cannot change files, stage drafts/);
    assert.match(block, /ONE sentence and offer to do it when he types the request/);
    assert.match(block, /type 'draft the reply to Priya' and I'll stage it/);
    assert.doesNotMatch(block, /staging drafts for approval are fine/);
    assert.match(block, /NEVER treat it as approval/, "the authority line stays in both modes");
  }
  const writable = voicePromptBlock({ privateMode: false, allowWrites: true });
  assert.match(writable, /Read-only work and staging drafts for approval are fine/);
  assert.match(writable, /tell him to approve it by typing on the screen/);
  assert.match(writable, /NEVER treat it as approval/);
  assert.doesNotMatch(writable, /READ-ONLY:/);
});

test("chat route: a voice turn hands allowWrites from policy to the agent (default false); typed turns carry no voice", async () => {
  const server = await harness("henry-voice-allowwrites-");
  try {
    await send(server.base, { prompt: "summarise my calendar for tomorrow", voice: true });
    assert.equal(server.calls.at(-1)!.options.voice?.allowWrites, false);
    updateSettings(server.runtime.config.settingsPath, { voice: { allowWrites: true } });
    await send(server.base, { prompt: "summarise my calendar for tomorrow", voice: true });
    assert.equal(server.calls.at(-1)!.options.voice?.allowWrites, true);
    await send(server.base, { prompt: "summarise my calendar for tomorrow" });
    assert.equal(server.calls.at(-1)!.options.voice, undefined);
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// THE APPROVAL RAIL
// ---------------------------------------------------------------------------

test("approval rail: a voice transcript with approval grammar never executes; the same typed text still does", async () => {
  const server = await harness("henry-voice-rail-");
  try {
    const item = await server.runtime.approvals.create({
      kind: "gmail.send", title: "Reply to recruiter", recipient: "r@example.com", subject: "Re: role", body: "Thanks, confirming Tuesday.", payload: {},
    });
    const tweet = await server.runtime.approvals.create({ kind: "social.x-post", title: "Daily tweet", body: "Rust 2.0 ships", payload: {} });
    for (const spoken of [`approve ${item.id}`, `I explicitly approve ${item.id}.`, "approve: Thanks, confirming Tuesday.", "approve it", "post it", "send it"]) {
      const events = await send(server.base, { prompt: spoken, voice: true, transcriptId: "tr-1" });
      assert.equal(server.executed.length, 0, `voice "${spoken}" must not execute`);
      assert.ok(events.some((entry) => entry.event === "done"), "the turn still completes");
    }
    assert.equal(server.calls.length, 6, "every voice approval phrase went to the model as ordinary speech");
    assert.ok(server.calls.every((call) => call.options.voice?.privateMode === false), "the agent is told the turn is voice");
    assert.ok(server.calls.every((call) => /never treat it as approval/i.test(call.built)), "and cannot approve/send");
    assert.equal((await server.runtime.approvals.get(item.id))?.status, "pending", "nothing was even approved");
    assert.equal((await server.runtime.approvals.get(tweet.id))?.status, "pending");

    // Control: the identical words TYPED still run the explicit approval path.
    const typed = await send(server.base, { prompt: `approve ${item.id}` });
    assert.deepEqual(server.executed, [item.id]);
    assert.match(String(typed.find((entry) => entry.event === "done")?.data.response), /executed/);
    assert.equal(server.calls.length, 6, "typed approval short-circuits before the model");
  } finally { await server.close(); }
});

// ---------------------------------------------------------------------------
// SSE: spoken events on Codex- and Claude-shaped streams
// ---------------------------------------------------------------------------

const codexStream: Script = (emit) => {
  const answer = "```spoken\nDrafted the reply to priya@example.com. Want me to stage it?\n```\nHere is the draft body in full.";
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "thread.started", thread_id: "t" } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "reasoning", text: "secret thinking" } } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.started", item: { type: "command_execution", command: "gmail list" } } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.started", item: { type: "agent_message", text: "partial" } } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "agent_message", text: answer } } });
  return answer;
};

const claudeStream: Script = (emit) => {
  const answer = "```spoken\nOn it, call 98765 43210 later.\n```\nFull Claude answer.";
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "system", subtype: "init" } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "ls" } }] } } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "user", message: { content: [{ type: "tool_result", content: "files" }] } } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "assistant", message: { content: [{ type: "text", text: answer }] } } });
  emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "result", subtype: "success", result: answer } });
  return answer;
};

const claudeDeltaStream: Script = (emit) => {
  const chunks = ["```spo", "ken\nShort ", "line.\n```", "\nRest of ", "the answer."];
  for (const text of chunks) emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } } });
  return chunks.join("");
};

test("SSE: Codex-shaped voice turn emits spoken before the answer, strips fences, redacts done.spoken", async () => {
  const server = await harness("henry-voice-codex-");
  try {
    server.script.current = codexStream;
    const events = await send(server.base, { prompt: "draft a reply to the recruiter email", voice: true, transcriptId: "abc-123" });
    const order = events.map((entry) => entry.event);
    const spokenIndex = order.indexOf("spoken");
    assert.ok(spokenIndex >= 0 && spokenIndex < order.indexOf("token") && order.indexOf("token") < order.indexOf("done"), order.join(","));
    assert.equal(order.filter((name) => name === "spoken").length, 1);
    assert.equal(events[spokenIndex].data.text, "Drafted the reply to on your screen. Want me to stage it?");
    const tokens = tokensOf(events);
    assert.doesNotMatch(tokens, /```spoken|partial|secret thinking|gmail list/);
    assert.match(tokens, /Here is the draft body in full\./);
    const done = events.find((entry) => entry.event === "done")!.data;
    assert.equal(done.response, "Here is the draft body in full.");
    assert.equal(done.spoken, "Drafted the reply to on your screen. Want me to stage it?");
    assert.equal(done.transcriptId, "abc-123");
    const history = await (await fetch(`${server.base}/api/chat/history`)).json() as { messages: Array<{ text: string }> };
    assert.doesNotMatch(history.messages.at(-1)!.text, /```spoken/, "the fence never reaches history");

    // A malformed transcriptId is dropped, not echoed.
    const bad = await send(server.base, { prompt: "draft a reply to the recruiter email", voice: true, transcriptId: "../etc" });
    assert.equal(bad.find((entry) => entry.event === "done")!.data.transcriptId, undefined);
  } finally { await server.close(); }
});

test("SSE: Claude failover shapes (whole assistant messages and text deltas) produce the same spoken flow", async () => {
  const server = await harness("henry-voice-claude-");
  try {
    server.script.current = claudeStream;
    const events = await send(server.base, { prompt: "what is on my calendar this afternoon", voice: true });
    const order = events.map((entry) => entry.event);
    assert.ok(order.indexOf("spoken") >= 0 && order.indexOf("spoken") < order.indexOf("token"), order.join(","));
    assert.equal(events.find((entry) => entry.event === "spoken")!.data.text, "On it, call on your screen later.");
    const tokens = tokensOf(events);
    assert.equal(tokens.trim(), "Full Claude answer.", "tool_use, tool_result and the result echo are not forwarded");
    const done = events.find((entry) => entry.event === "done")!.data;
    assert.equal(done.response, "Full Claude answer.");
    assert.equal(done.spoken, "On it, call on your screen later.");

    server.script.current = claudeDeltaStream;
    const deltas = await send(server.base, { prompt: "what is on my calendar this afternoon", voice: true });
    const deltaOrder = deltas.map((entry) => entry.event);
    assert.equal(deltaOrder.filter((name) => name === "spoken").length, 1);
    assert.ok(deltaOrder.indexOf("spoken") < deltaOrder.indexOf("token"));
    assert.equal(deltas.find((entry) => entry.event === "spoken")!.data.text, "Short line.");
    assert.equal(tokensOf(deltas).replace(/\s+/g, " ").trim(), "Rest of the answer.");
  } finally { await server.close(); }
});

test("SSE: private mode forces the neutral line on every spoken string", async () => {
  const server = await harness("henry-voice-private-");
  const settingsPath = server.runtime.config.settingsPath;
  try {
    updateSettings(settingsPath, { voice: { privateMode: true } });
    server.script.current = claudeStream;
    const events = await send(server.base, { prompt: "read me my latest bank email", voice: true });
    assert.equal(events.find((entry) => entry.event === "spoken")!.data.text, PRIVATE_SPOKEN_DONE);
    assert.equal(events.find((entry) => entry.event === "done")!.data.spoken, PRIVATE_SPOKEN_DONE);
    assert.equal(server.calls.at(-1)!.options.voice?.privateMode, true);
    assert.match(server.calls.at(-1)!.built, /PRIVATE MODE IS ON/);

    server.script.current = codexStream; // its spoken line ends in a question
    const asking = await send(server.base, { prompt: "draft a reply to the recruiter email", voice: true });
    assert.equal(asking.find((entry) => entry.event === "spoken")!.data.text, PRIVATE_SPOKEN_INPUT);
  } finally {
    updateSettings(settingsPath, { voice: { privateMode: false } });
    await server.close();
  }
});

test("non-voice turns are unchanged: no spoken events, no done.spoken, no prompt block", async () => {
  const server = await harness("henry-voice-typed-");
  try {
    server.script.current = codexStream;
    const events = await send(server.base, { prompt: "draft a reply to the recruiter email", transcriptId: "abc-123" });
    assert.ok(!events.some((entry) => entry.event === "spoken"));
    const done = events.find((entry) => entry.event === "done")!.data;
    assert.equal(done.spoken, undefined);
    assert.equal(done.transcriptId, undefined, "transcriptId is ignored without voice:true");
    assert.match(String(done.response), /```spoken/, "a typed reply is passed through untouched");
    assert.equal(server.calls[0].options.voice, undefined);
    assert.doesNotMatch(server.calls[0].built, /VOICE TURN/);
    // voice must be literally true; truthy strings do not turn a turn into a voice turn.
    const stringy = await send(server.base, { prompt: "draft a reply to the recruiter email", voice: "true" });
    assert.ok(!stringy.some((entry) => entry.event === "spoken"));
  } finally { await server.close(); }
});
