/**
 * The voice rail in CODE: a voice turn's provider child carries HENRY_VOICE_TURN=1, and every
 * approve / claim / execute / send path refuses under it. Staging stays allowed.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { ActivityLog } from "../src/activity.ts";
import { ApprovalStore } from "../src/approval/store.ts";
import { executeExplicitApproval } from "../src/approval/explicit.ts";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { VOICE_TURN_IN_FLIGHT_REFUSAL, VOICE_TURN_REFUSAL, assertOutboundExecutionClaim } from "../src/guardrails.ts";
import { AdmissionController } from "../src/orchestration/admission.ts";
import { ProviderRunner, execute, type RunOptions } from "../src/providers/runner.ts";
import {
  CAPABILITY_FILE, CODEX_GMAIL_APP_ID, codexMailServers, codexVoiceTurnOverrides,
} from "../src/providers/capabilities.ts";
import { ReminderService } from "../src/reminders/service.ts";
import { startReminderTicker, __resetReminderTickerForTests } from "../src/reminders/ticker.ts";
import { XApiPoster } from "../src/social/tweets.ts";
import { HenryRuntime } from "../src/runtime.ts";
import { updateSettings } from "../src/util/settings.ts";
import { startDashboard } from "../src/dashboard/server.ts";
import type { ProviderName, RunResult } from "../src/types.ts";

delete process.env.HENRY_VOICE_TURN;
delete process.env.HENRY_VOICE_ALLOW_WRITES;
const REPO = process.cwd();

async function withVoice<T>(fn: () => Promise<T> | T): Promise<T> {
  const previous = process.env.HENRY_VOICE_TURN;
  process.env.HENRY_VOICE_TURN = "1";
  try { return await fn(); } finally {
    if (previous === undefined) delete process.env.HENRY_VOICE_TURN; else process.env.HENRY_VOICE_TURN = previous;
  }
}

function tmp(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function store(): Promise<ApprovalStore> {
  const approvals = new ApprovalStore(path.join(tmp("henry-voice-approvals-"), "approvals.json"));
  await approvals.init();
  return approvals;
}

function stage(approvals: ApprovalStore) {
  return approvals.create({ kind: "gmail.send", title: "Email a@example.com: hi", recipient: "a@example.com", subject: "hi", body: "hello", payload: {} });
}

/* ---------------- 1. the flag reaches the provider child ---------------- */

test("execute(): a voice turn's child env carries HENRY_VOICE_TURN=1; a normal turn's does not", async () => {
  const voice = await execute("env", [], os.tmpdir(), "codex", { voiceTurn: true, timeoutMs: 10_000 });
  assert.match(voice.response, /^HENRY_VOICE_TURN=1$/m);
  const normal = await execute("env", [], os.tmpdir(), "codex", { timeoutMs: 10_000 });
  assert.doesNotMatch(normal.response, /HENRY_VOICE_TURN/);
});

test("execute(): a process already inside a voice turn re-propagates the flag to its own children (grandchild CLI calls)", async () => {
  const inherited = await withVoice(() => execute("env", [], os.tmpdir(), "claude", { timeoutMs: 10_000 }));
  assert.match(inherited.response, /^HENRY_VOICE_TURN=1$/m);
});

interface Attempt { provider: ProviderName; args: string[]; options: RunOptions }

function runnerHarness(provider: ProviderName, capabilities?: unknown) {
  const root = tmp("henry-voice-runner-");
  const dataDir = path.join(root, "data");
  fs.mkdirSync(dataDir, { recursive: true });
  if (capabilities) fs.writeFileSync(path.join(dataDir, CAPABILITY_FILE), JSON.stringify(capabilities));
  const activity = new ActivityLog(path.join(dataDir, "activity.jsonl"));
  const config = { rootDir: root, dataDir, settingsPath: path.join(dataDir, "settings.json"), provider } as HenryConfig;
  const attempts: Attempt[] = [];
  const runner = new ProviderRunner(config, activity, new AdmissionController({ pressureTtlMs: 0, samplePressure: async () => "ok" }), {
    execute: async (_command, args, _cwd, which, options = {}) => {
      attempts.push({ provider: which, args, options });
      return { runId: randomUUID(), provider: which, response: "ok", exitCode: 0, durationMs: 1, events: [] } satisfies RunResult;
    },
    now: () => new Date(),
    notify: async () => undefined,
  });
  return { runner, attempts, activity };
}

test("ProviderRunner: voiceTurn reaches the spawn and adds the Codex connector rail; a normal run gets neither", async () => {
  const codexHome = tmp("henry-voice-codexhome-");
  fs.writeFileSync(path.join(codexHome, "config.toml"), [
    '[mcp_servers.gmail]', 'command = "npx"', '', '[mcp_servers.node_repl]', 'command = "x"', '', '[mcp_servers."work-mail"]', 'url = "https://x"',
  ].join("\n"));
  const previousHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = codexHome;
  try {
    const { runner, attempts, activity } = runnerHarness("codex");
    await activity.init();
    await runner.run("read my mail", { voiceTurn: true });
    await runner.run("read my mail");
    const [voice, normal] = attempts;
    assert.equal(voice.options.voiceTurn, true, "the spawn is told it serves a voice turn");
    assert.ok(!normal.options.voiceTurn, "a normal run is not");
    const joined = voice.args.join(" ");
    assert.match(joined, new RegExp(`apps\\.${CODEX_GMAIL_APP_ID}\\.open_world_enabled=false`));
    assert.match(joined, /apps\._default\.open_world_enabled=false/);
    assert.match(joined, new RegExp(`apps\\.${CODEX_GMAIL_APP_ID}\\.tools\\."gmail\\.send_email"\\.enabled=false`));
    assert.match(joined, /mcp_servers\.gmail\.enabled=false/);
    assert.match(joined, /mcp_servers\.work-mail\.enabled=false/);
    assert.doesNotMatch(joined, /node_repl/);
    assert.match(joined, /shell_environment_policy\.set\.HENRY_VOICE_TURN="1"/);
    assert.doesNotMatch(normal.args.join(" "), /open_world_enabled|mcp_servers|HENRY_VOICE_TURN/);
  } finally {
    if (previousHome === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previousHome;
  }
});

test("ProviderRunner: a voice turn on Claude denies the cached Gmail send tools; a normal run does not", async () => {
  const gmail = { status: "connected", checkedAt: new Date().toISOString(), tools: ["mcp__claude_ai_Gmail__search_threads", "mcp__claude_ai_Gmail__create_draft", "mcp__claude_ai_Gmail__send_message"] };
  const { runner, attempts, activity } = runnerHarness("claude", { claude: { gmail } });
  await activity.init();
  await runner.run("hi", { voiceTurn: true });
  await runner.run("hi");
  const voiceDenied = attempts[0].args[attempts[0].args.indexOf("--disallowedTools") + 1] ?? "";
  assert.match(voiceDenied, /mcp__claude_ai_Gmail__send_message/);
  assert.doesNotMatch(voiceDenied, /search_threads|create_draft/, "reads and drafts stay available");
  assert.ok(!attempts[1].args.includes("--disallowedTools"));
});

test("codexVoiceTurnOverrides: flag-paired, portable, and only names mail servers that exist", () => {
  const bare = codexVoiceTurnOverrides("");
  assert.equal(bare.length % 2, 0);
  assert.ok(bare.filter((_, index) => index % 2 === 0).every((flag) => flag === "-c"));
  assert.ok(!bare.some((value) => value.startsWith("mcp_servers.")), "no config.toml → no server overrides (Codex rejects a transport-less server)");
  assert.deepEqual(codexMailServers('[mcp_servers.gmail]\n[mcp_servers.slack]\n[mcp_servers."Mail Box"]\n[mcp_servers.gmail.env]'), ["gmail", "Mail Box"]);
});

test("agent.run with a voice turn hands voiceTurn to the runner; a typed turn does not", async () => {
  const runtime = await HenryRuntime.create(tmpRoot());
  const seen: RunOptions[] = [];
  (runtime.agent.providerRunner as unknown as { run: unknown }).run = async (_prompt: string, options: RunOptions) => {
    seen.push(options);
    return { runId: "r", provider: "codex", response: "", exitCode: 0, durationMs: 1, events: [] };
  };
  await runtime.agent.run("what is on my calendar", { voice: { privateMode: false } });
  await runtime.agent.run("what is on my calendar");
  assert.equal(seen[0].voiceTurn, true);
  assert.ok(!seen[1].voiceTurn);
  assert.ok(!("voice" in seen[0]), "the prompt-only voice context never reaches the runner");
});

test("agent.run: a voice turn is read-only by default, writable only with allowWrites; typed turns and caller readOnly unchanged", async () => {
  const runtime = await HenryRuntime.create(tmpRoot());
  const seen: RunOptions[] = [];
  (runtime.agent.providerRunner as unknown as { run: unknown }).run = async (_prompt: string, options: RunOptions) => {
    seen.push(options);
    return { runId: "r", provider: "codex", response: "", exitCode: 0, durationMs: 1, events: [] };
  };
  try {
    await runtime.agent.run("summarise my inbox", { voice: { privateMode: false } });
    await runtime.agent.run("summarise my inbox", { voice: { privateMode: false, allowWrites: false } });
    await runtime.agent.run("summarise my inbox", { voice: { privateMode: false, allowWrites: true } });
    await runtime.agent.run("summarise my inbox");
    await runtime.agent.run("summarise my inbox", { readOnly: true, voice: { privateMode: false, allowWrites: true } });
    assert.equal(seen[0].readOnly, true, "default voice turn is sandboxed");
    assert.equal(seen[1].readOnly, true);
    assert.ok(!seen[2].readOnly, "allowWrites lifts the sandbox");
    assert.ok(!seen[3].readOnly, "a typed turn is unchanged");
    assert.equal(seen[4].readOnly, true, "a caller's own readOnly is never loosened");
    assert.ok(seen.slice(0, 3).every((options) => options.voiceTurn === true), "the env rail stays on in both voice modes");
    assert.ok(!seen[3].voiceTurn);
  } finally { runtime.close(); }
});

/** agent.run through the REAL ProviderRunner with only the spawn stubbed: the argv a voice turn gets. */
async function voiceArgv(provider: ProviderName, voice?: { privateMode: boolean; allowWrites?: boolean }): Promise<string[]> {
  const runtime = await HenryRuntime.create(tmpRoot());
  runtime.config.provider = provider;
  const attempts: string[][] = [];
  (runtime.agent.providerRunner as unknown as { executeFn: unknown }).executeFn = async (_command: string, args: string[], _cwd: string, which: ProviderName) => {
    attempts.push(args);
    return { runId: randomUUID(), provider: which, response: "ok", exitCode: 0, durationMs: 1, events: [] } satisfies RunResult;
  };
  try {
    await runtime.agent.run("summarise the latest research on local speech models", voice ? { voice } : {});
    await runtime.agent.flushMemoryCaptures();
  } finally { runtime.close(); }
  assert.equal(attempts.length, 1);
  return attempts[0];
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

test("argv: a Codex voice turn runs --sandbox read-only; allowWrites and typed turns keep danger-full-access", async () => {
  const readOnly = await voiceArgv("codex", { privateMode: false });
  assert.equal(flagValue(readOnly, "--sandbox"), "read-only");
  assert.ok(!readOnly.includes("danger-full-access"));
  assert.ok(readOnly.join(" ").includes('shell_environment_policy.set.HENRY_VOICE_TURN="1"'), "env rail rides along");
  const writable = await voiceArgv("codex", { privateMode: false, allowWrites: true });
  assert.equal(flagValue(writable, "--sandbox"), "danger-full-access");
  assert.ok(writable.join(" ").includes('shell_environment_policy.set.HENRY_VOICE_TURN="1"'));
  const typed = await voiceArgv("codex");
  assert.equal(flagValue(typed, "--sandbox"), "danger-full-access");
  assert.ok(!typed.join(" ").includes("HENRY_VOICE_TURN"));
});

test("argv: a Claude voice turn runs dontAsk with the read allowlist and write tools denied; allowWrites and typed turns skip permissions", async () => {
  const readOnly = await voiceArgv("claude", { privateMode: false });
  assert.equal(flagValue(readOnly, "--permission-mode"), "dontAsk");
  assert.equal(flagValue(readOnly, "--allowedTools"), "Read,Grep,Glob,WebSearch,WebFetch");
  assert.deepEqual(flagValue(readOnly, "--disallowedTools")?.split(",").slice(0, 4), ["Bash", "Edit", "Write", "NotebookEdit"]);
  assert.ok(!readOnly.includes("--dangerously-skip-permissions"));
  for (const args of [await voiceArgv("claude", { privateMode: false, allowWrites: true }), await voiceArgv("claude")]) {
    assert.ok(args.includes("--dangerously-skip-permissions"));
    assert.ok(!args.includes("--permission-mode"));
  }
});

test("startInteractiveTurn: a voice turn delegated to Luna research runs read-only AND under the voice rail", async () => {
  const runtime = await HenryRuntime.create(tmpRoot());
  const seen: RunOptions[] = [];
  (runtime.luna as unknown as { runner: { run: unknown } }).runner.run = async (_prompt: string, options: RunOptions) => {
    seen.push(options);
    return { runId: "r", provider: "codex", response: "", exitCode: 0, durationMs: 1, events: [] };
  };
  const turn = runtime.startInteractiveTurn("do deep research on local speech engines", { voice: { privateMode: false } } as never);
  assert.equal(turn.delegated, true);
  await turn.completion;
  assert.equal(seen[0].readOnly, true, "Luna research is read-only");
  assert.equal(seen[0].voiceTurn, true, "connector tools sit outside the sandbox, so the rail still applies");
});

function tmpRoot(): string {
  const root = tmp("henry-voice-rail-");
  fs.cpSync(path.join(REPO, "workflows"), path.join(root, "workflows"), { recursive: true });
  return root;
}

/* ---------------- 2. every refusal point ---------------- */

test("ApprovalStore: approve and claim refuse during a voice turn; staging and rejecting still work", async () => {
  const approvals = await store();
  await withVoice(async () => {
    const staged = await stage(approvals);
    assert.equal(staged.status, "pending", "staging a pending approval is allowed on a voice turn");
    await assert.rejects(approvals.setStatus(staged.id, "approved"), { message: VOICE_TURN_REFUSAL });
    assert.equal((await approvals.get(staged.id))?.status, "pending");
    const other = await stage(approvals);
    await approvals.setStatus(other.id, "rejected");
    assert.equal((await approvals.get(other.id))?.status, "rejected");
  });
  const item = await stage(approvals);
  await approvals.setStatus(item.id, "approved");
  await withVoice(() => assert.rejects(approvals.claimForExecution(item.id), { message: VOICE_TURN_REFUSAL }));
  assert.equal((await approvals.get(item.id))?.status, "approved", "a refused claim leaves the item untouched");
  assert.equal((await approvals.claimForExecution(item.id)).status, "executing", "outside a voice turn it claims normally");
});

test("explicit approval executor refuses during a voice turn and works normally otherwise", async () => {
  const approvals = await store();
  const item = await stage(approvals);
  const executed: string[] = [];
  const runtime = {
    approvals,
    approve: (id: string) => approvals.setStatus(id, "approved").then(() => undefined),
    executeApproval: async (id: string) => { executed.push(id); return `sent ${id}`; },
  };
  await withVoice(async () => {
    await assert.rejects(executeExplicitApproval(runtime, `approve ${item.id}`), { message: VOICE_TURN_REFUSAL });
    assert.equal(await executeExplicitApproval(runtime, "what is the weather"), undefined, "non-approval text is untouched");
  });
  assert.deepEqual(executed, []);
  assert.equal(await executeExplicitApproval(runtime, `approve ${item.id}`), `sent ${item.id}`);
});

test("outbound integrations: the execution-claim guard and the X API poster refuse during a voice turn", async () => {
  await withVoice(async () => {
    assert.throws(() => assertOutboundExecutionClaim({ kind: "gmail.send", status: "executing" }), { message: VOICE_TURN_REFUSAL });
    let fetched = false;
    const poster = new XApiPoster({ apiKey: "k", apiSecret: "s", accessToken: "t", accessSecret: "a" } as never, (async () => { fetched = true; return new Response("{}"); }) as typeof fetch);
    await assert.rejects(poster.post("hello"), { message: VOICE_TURN_REFUSAL });
    assert.equal(fetched, false, "no request left the machine");
  });
  assert.doesNotThrow(() => assertOutboundExecutionClaim({ kind: "gmail.send", status: "executing" }));
});

test("reminders: --execute-approval creation refuses during a voice turn; other reminders are stamped and still created", async () => {
  const config = loadConfig(tmp("henry-voice-reminders-"));
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const reminders = new ReminderService(config, activity);
  const due = new Date(Date.now() + 60_000);
  await withVoice(async () => {
    await assert.rejects(reminders.createApprovalExecute(randomUUID(), due), { message: VOICE_TURN_REFUSAL });
    const spoken = await reminders.create("check the oven", due, "prompt");
    assert.equal(spoken.voiceTurn, true);
  });
  const typed = await reminders.createApprovalExecute(randomUUID(), due);
  assert.equal(typed.kind, "approval.execute");
  assert.ok(!typed.voiceTurn);
});

test("scheduler/ticker: an approval-execute reminder cannot execute inside a voice-turn process, executes normally outside", async () => {
  const config = loadConfig(tmp("henry-voice-ticker-"));
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const approvals = new ApprovalStore(config.approvalsPath);
  await approvals.init();
  const reminders = new ReminderService(config, activity);
  const item = await stage(approvals);
  await approvals.setStatus(item.id, "approved");
  const sent: string[] = [];
  // The same shape as HenryRuntime.executeApproval: claim, then deliver.
  const executeApproval = async (id: string) => { await approvals.claimForExecution(id); sent.push(id); await approvals.setStatus(id, "executed", "ok"); return "ok"; };
  const past = new Date(Date.now() - 1_000);
  const messages: string[] = [];

  await reminders.createApprovalExecute(item.id, past);
  // A voice turn that starts the daemon/ticker hands the flag to the whole process.
  await withVoice(async () => {
    __resetReminderTickerForTests();
    const handle = startReminderTicker(reminders, activity, {
      notify: async (message) => { messages.push(message); }, executeApproval, pollMs: 60_000, lockPath: path.join(config.dataDir, "ticker.lock"),
    });
    for (let i = 0; i < 100 && messages.length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    handle?.stop();
  });
  assert.deepEqual(sent, []);
  assert.match(messages[0] ?? "", /Scheduled send skipped: Approvals and outbound sends are disabled during a voice turn/);
  assert.equal((await approvals.get(item.id))?.status, "approved");

  await reminders.createApprovalExecute(item.id, past);
  await reminders.fireDue(async (message) => { messages.push(message); }, new Date(), undefined, executeApproval);
  assert.deepEqual(sent, [item.id], "outside a voice turn the approved item executes");
});

test("fireDue: a reminder stamped by a voice turn runs its prompt under the rail and never executes an approval", async () => {
  const config = loadConfig(tmp("henry-voice-stamped-"));
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const reminders = new ReminderService(config, activity);
  const past = new Date(Date.now() - 1_000);
  await withVoice(() => reminders.create("approve and send everything", past, "prompt"));
  await reminders.create("typed prompt", past, "prompt");
  const promptOptions: Array<{ voiceTurn?: boolean } | undefined> = [];
  await reminders.fireDue(async () => undefined, new Date(), async (_prompt, options) => { promptOptions.push(options); return "ok"; });
  assert.deepEqual(promptOptions, [{ voiceTurn: true }, undefined]);

  // An approval.execute reminder stamped voiceTurn (written to the file by other means) is refused at fire time.
  const raw = JSON.parse(fs.readFileSync(config.remindersPath, "utf8")) as Array<Record<string, unknown>>;
  raw.push({ id: randomUUID(), text: "x", kind: "approval.execute", approvalId: randomUUID(), dueAt: past.toISOString(), status: "pending", createdAt: past.toISOString(), voiceTurn: true });
  fs.writeFileSync(config.remindersPath, JSON.stringify(raw));
  const fresh = new ReminderService(config, activity);
  const executed: string[] = [];
  const messages: string[] = [];
  await fresh.fireDue(async (message) => { messages.push(message); }, new Date(), undefined, async (id) => { executed.push(id); return "ok"; });
  assert.deepEqual(executed, []);
  assert.match(messages.join("\n"), /Scheduled send skipped: Approvals and outbound sends are disabled during a voice turn/);
});

/* ---------------- 3. the CLI entry ---------------- */

function cli(dataDir: string, argv: string[], voice: boolean) {
  const env: NodeJS.ProcessEnv = { ...process.env, HENRY_DATA_DIR: dataDir, HENRY_MEMORY_DIR: path.join(dataDir, "memory") };
  if (voice) env.HENRY_VOICE_TURN = "1"; else delete env.HENRY_VOICE_TURN;
  const result = spawnSync(process.execPath, ["--import", "tsx", path.join(REPO, "src/cli.ts"), ...argv], { cwd: REPO, env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, out: `${result.stdout}\n${result.stderr}` };
}

test("CLI: approve approve|send and remind --execute-approval refuse during a voice turn and behave normally otherwise", async () => {
  const dataDir = tmp("henry-voice-cli-");
  const approvals = new ApprovalStore(path.join(dataDir, "approvals.json"));
  await approvals.init();
  const item = await stage(approvals);

  const approveVoice = cli(dataDir, ["approve", "approve", item.id], true);
  assert.notEqual(approveVoice.status, 0);
  assert.match(approveVoice.out, /Approvals and outbound sends are disabled during a voice turn/);
  assert.equal((await approvals.get(item.id))?.status, "pending");

  const sendVoice = cli(dataDir, ["approve", "send", item.id], true);
  assert.notEqual(sendVoice.status, 0);
  assert.match(sendVoice.out, /Approvals and outbound sends are disabled during a voice turn/);

  const remindVoice = cli(dataDir, ["remind", "--execute-approval", item.id, "--in", "2h"], true);
  assert.notEqual(remindVoice.status, 0);
  assert.match(remindVoice.out, /Approvals and outbound sends are disabled during a voice turn/);

  // Staging is still allowed on a voice turn.
  const draftVoice = cli(dataDir, ["gmail", "draft", "--to", "b@example.com", "--subject", "s", "--body", "b"], true);
  assert.equal(draftVoice.status, 0, draftVoice.out);
  assert.match(draftVoice.out, /queued for Luvish's approval/);

  // Normal behaviour: send of a pending item hits the ordinary gate (never reaching any outbound code),
  // approve succeeds, and the scheduled send is created.
  const sendTyped = cli(dataDir, ["approve", "send", item.id], false);
  assert.notEqual(sendTyped.status, 0);
  assert.match(sendTyped.out, /Sending is blocked: approval .* is pending/);
  const approveTyped = cli(dataDir, ["approve", "approve", item.id], false);
  assert.equal(approveTyped.status, 0, approveTyped.out);
  assert.equal((await approvals.get(item.id))?.status, "approved");
  const remindTyped = cli(dataDir, ["remind", "--execute-approval", item.id, "--in", "2h"], false);
  assert.equal(remindTyped.status, 0, remindTyped.out);
  assert.match(remindTyped.out, /approval\.execute/);
});

/* ---------------- 4. the dashboard's loopback surface ---------------- */

test("dashboard: while a WRITABLE voice turn is in flight, approval routes and typed approval grammar refuse; afterwards they work", async () => {
  const runtime = await HenryRuntime.create(tmpRoot());
  updateSettings(runtime.config.settingsPath, { voice: { allowWrites: true } });
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  (runtime.agent as unknown as { run: unknown }).run = async () => {
    await gate;
    return { runId: "r", provider: "codex", response: "ok", exitCode: 0, durationMs: 1, events: [] };
  };
  const executed: string[] = [];
  (runtime as unknown as { executeApproval: unknown }).executeApproval = async (id: string) => { executed.push(id); return "sent"; };
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const post = (pathname: string, payload: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(payload));
  });
  try {
    const item = await stage(runtime.approvals);
    const other = JSON.parse((await post("/api/conversations", { title: "typed thread" })).body) as { id?: string; conversation?: { id: string } };
    const otherId = other.id ?? other.conversation?.id;
    assert.ok(otherId, "a second conversation exists for the typed turn");
    const spoken = JSON.parse((await post("/api/conversations", { title: "voice thread" })).body) as { conversation: { id: string } };
    const voiceTurn = post("/api/chat/send", { prompt: "what is new", voice: true, conversationId: spoken.conversation.id });
    for (let i = 0; i < 50; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    const blocked = await post(`/api/approvals/${item.id}/approve-execute`, {});
    assert.equal(blocked.status, 409);
    assert.match(blocked.body, /disabled while a voice turn is running/);
    const typed = await post("/api/chat/send", { prompt: `approve ${item.id}`, conversationId: otherId });
    assert.match(typed.body, new RegExp(VOICE_TURN_IN_FLIGHT_REFUSAL.slice(0, 40)));
    assert.equal((await runtime.approvals.get(item.id))?.status, "pending");
    release();
    await voiceTurn;
    const allowed = await post(`/api/approvals/${item.id}/approve-execute`, {});
    assert.equal(allowed.status, 200, allowed.body);
    assert.deepEqual(executed, [item.id]);
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("dashboard: a READ-ONLY voice turn (the default) in flight does not block the owner's approvals", async () => {
  const runtime = await HenryRuntime.create(tmpRoot());
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let voiceStarted = false;
  (runtime.agent as unknown as { run: unknown }).run = async (_prompt: string, options: { voice?: unknown } = {}) => {
    if (options.voice) { voiceStarted = true; await gate; }
    return { runId: "r", provider: "codex", response: "ok", exitCode: 0, durationMs: 1, events: [] };
  };
  const executed: string[] = [];
  (runtime as unknown as { executeApproval: unknown }).executeApproval = async (id: string) => { executed.push(id); return "sent"; };
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const port = (server.address() as { port: number }).port;
  const post = (pathname: string, payload: unknown) => new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = http.request({ host: "127.0.0.1", port, path: pathname, method: "POST", headers: { "content-type": "application/json" } }, (response) => {
      let body = "";
      response.on("data", (chunk) => { body += chunk; });
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on("error", reject);
    request.end(JSON.stringify(payload));
  });
  try {
    const item = await stage(runtime.approvals);
    const second = await stage(runtime.approvals);
    const other = JSON.parse((await post("/api/conversations", { title: "typed thread" })).body) as { id?: string; conversation?: { id: string } };
    const otherId = other.id ?? other.conversation?.id;
    const spoken = JSON.parse((await post("/api/conversations", { title: "voice thread" })).body) as { conversation: { id: string } };
    const voiceTurn = post("/api/chat/send", { prompt: "what is new", voice: true, conversationId: spoken.conversation.id });
    for (let i = 0; i < 50 && !voiceStarted; i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(voiceStarted, "the voice turn is in flight");
    const allowed = await post(`/api/approvals/${item.id}/approve-execute`, {});
    assert.equal(allowed.status, 200, allowed.body);
    const typed = await post("/api/chat/send", { prompt: `approve ${second.id}`, conversationId: otherId });
    assert.doesNotMatch(typed.body, new RegExp(VOICE_TURN_IN_FLIGHT_REFUSAL.slice(0, 40)));
    assert.equal((await runtime.approvals.get(second.id))?.status, "approved");
    assert.ok(executed.includes(item.id));
    release();
    await voiceTurn;
  } finally {
    release();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
