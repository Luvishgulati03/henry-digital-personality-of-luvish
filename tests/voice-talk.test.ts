import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { HenryRuntime } from "../src/runtime.ts";
import {
  DEFAULT_TTS_SPEED, DEFAULT_TTS_VOICE, TALK_PHRASES, speakableForRoute, startDashboard,
  ttsPromptCacheHash, ttsVoiceFromEnv, vendorVadAsset, voiceVocabularyPrompt, type DashboardVoice,
} from "../src/dashboard/server.ts";
import { PRIVATE_SPOKEN_DONE, PRIVATE_SPOKEN_INPUT, PRIVATE_SPOKEN_WORKING } from "../src/voice/policy.ts";
import { isLookupRequest, isToolStart } from "../src/voice/intent.ts";
import { readSettings, updateSettings } from "../src/util/settings.ts";

delete process.env.HENRY_VOICE_PRIVATE;
delete process.env.HENRY_VOICE_ALLOW_WRITES;
delete process.env.HENRY_VOICE_VOCABULARY;
delete process.env.HENRY_TTS_VOICE;
delete process.env.HENRY_TTS_SPEED;

type Emit = (event: { timestamp: string; stream: string; text: string; parsed?: Record<string, unknown> }) => void;
type Script = (emit: Emit) => string;

function tone(samples = 160): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i / 3) * 6000), 44 + i * 2);
  return wav;
}

interface FakeVoice {
  voice: DashboardVoice;
  stt: Array<{ language?: string; prompt?: string; bytes: number }>;
  tts: string[];
  transcript: { current: string };
}

function fakeVoice(options: { stt?: boolean; tts?: boolean } = {}): FakeVoice {
  const stt: FakeVoice["stt"] = [];
  const tts: string[] = [];
  const transcript = { current: "what's the latest on Engram" };
  const voice = {
    sttEnabled: () => options.stt !== false,
    ttsEnabled: () => options.tts !== false,
    transcribe: async (wav: Uint8Array, opts: { language?: string; prompt?: string } = {}) => {
      stt.push({ language: opts.language, prompt: opts.prompt, bytes: wav.length });
      return { text: transcript.current, language: opts.language };
    },
    synthesize: async (text: string) => { tts.push(text); return tone(); },
  } as unknown as DashboardVoice;
  return { voice, stt, tts, transcript };
}

interface Harness {
  base: string;
  runtime: HenryRuntime;
  fake: FakeVoice;
  script: { current: Script };
  close(): Promise<void>;
}

function tempRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  return root;
}

async function harness(prefix: string, voiceOptions: { stt?: boolean; tts?: boolean } = {}): Promise<Harness> {
  const runtime = await HenryRuntime.create(tempRoot(prefix));
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  const script: { current: Script } = { current: (emit) => { emit({ timestamp: "", stream: "stdout", text: "", parsed: { text: "ok" } }); return "ok"; } };
  (runtime.agent as unknown as { run: unknown }).run = async (_prompt: string, options: { onEvent?: Emit; provider?: string } = {}) => {
    const response = script.current((event) => options.onEvent?.(event));
    return { runId: "run-1", provider: options.provider ?? "codex", response, exitCode: 0, durationMs: 5, events: [] };
  };
  const fake = fakeVoice(voiceOptions);
  const server = startDashboard(runtime, { voice: fake.voice, warmVoicePrompts: false });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    base: `http://127.0.0.1:${address.port}`, runtime, fake, script,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      runtime.close();
    },
  };
}

async function jsonOf(response: Response): Promise<Record<string, unknown>> {
  return await response.json() as Record<string, unknown>;
}

function frames(bytes: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let offset = 0;
  while (offset + 4 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    out.push(bytes.subarray(offset + 4, offset + 4 + length));
    offset += 4 + length;
  }
  assert.equal(offset, bytes.length, "frames end exactly at the stream end");
  return out;
}

async function send(base: string, body: Record<string, unknown>): Promise<Array<{ event: string; data: Record<string, unknown> }>> {
  const text = await (await fetch(`${base}/api/chat/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).text();
  return text.split("\n\n").filter(Boolean).map((chunk) => ({
    event: /^event: (.+)$/m.exec(chunk)?.[1] ?? "",
    data: JSON.parse(/^data: (.+)$/m.exec(chunk)?.[1] ?? "{}") as Record<string, unknown>,
  }));
}

// ---------------------------------------------------------------------------
// intent: when a voice turn earns a holding phrase
// ---------------------------------------------------------------------------

test("isLookupRequest: research and lookups yes, chit-chat never", () => {
  for (const prompt of [
    "research vector databases for me", "can you look up the Kokoro licence", "look it up", "search for flights to Goa",
    "find the PR Codex opened", "check my calendar for tomorrow", "what's the latest on Engram", "what is the latest news",
    "summarise the standup", "summarize this thread", "any news about OpenAI", "new jobs in Bangalore", "job postings for PMs",
    "anything in my inbox", "read my emails", "check mail", "what's on my calendar",
  ]) assert.equal(isLookupRequest(prompt), true, prompt);
  for (const prompt of [
    "hi Henry", "thanks", "how are you", "good job", "okay bye", "tell me a joke", "नमस्ते", "", "   ",
  ]) assert.equal(isLookupRequest(prompt), false, prompt);
});

test("isToolStart: Codex commands/tools/web search and Claude tool_use; nothing else", () => {
  for (const type of ["command_execution", "mcp_tool_call", "web_search", "custom_tool_call"]) {
    assert.equal(isToolStart({ type: "item.started", item: { type } }), true, type);
    assert.equal(isToolStart({ type: "item.completed", item: { type } }), true, type);
  }
  assert.equal(isToolStart({ type: "item.completed", item: { type: "agent_message", text: "hi" } }), false);
  assert.equal(isToolStart({ type: "item.started", item: { type: "reasoning" } }), false);
  assert.equal(isToolStart({ type: "assistant", message: { content: [{ type: "text", text: "a" }, { type: "tool_use", name: "WebSearch" }] } }), true);
  assert.equal(isToolStart({ type: "assistant", message: { content: [{ type: "text", text: "a" }] } }), false);
  assert.equal(isToolStart({ type: "stream_event", event: { type: "content_block_start", content_block: { type: "tool_use" } } }), true);
  assert.equal(isToolStart({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } }), false);
  assert.equal(isToolStart(undefined), false);
  assert.equal(isToolStart({ text: "plain" }), false);
});

// ---------------------------------------------------------------------------
// routes
// ---------------------------------------------------------------------------

test("GET /api/voice/status reports the engine, private mode, and allow-writes; disabled engines report cleanly", async () => {
  const on = await harness("henry-talk-status-");
  try {
    const status = await jsonOf(await fetch(`${on.base}/api/voice/status`));
    assert.deepEqual(status, {
      available: true, sttEnabled: true, ttsEnabled: true, talkEnabled: true, privateMode: false, allowWrites: false,
      ttsVoice: DEFAULT_TTS_VOICE, ttsSpeed: DEFAULT_TTS_SPEED,
    });
    updateSettings(on.runtime.config.settingsPath, { voice: { privateMode: true, allowWrites: true } });
    const flipped = await jsonOf(await fetch(`${on.base}/api/voice/status`));
    assert.equal(flipped.privateMode, true);
    assert.equal(flipped.allowWrites, true);
  } finally { await on.close(); }

  const off = await harness("henry-talk-status-off-", { stt: false, tts: false });
  try {
    const status = await jsonOf(await fetch(`${off.base}/api/voice/status`));
    assert.equal(status.available, false);
    assert.equal(status.sttEnabled, false);
    assert.equal(status.ttsEnabled, false);
    assert.match(String(status.reason), /henry start/);
    const transcribe = await fetch(`${off.base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(tone()) });
    assert.equal(transcribe.status, 503);
    const speak = await fetch(`${off.base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "hello" }) });
    assert.equal(speak.status, 503);
    assert.equal((await fetch(`${off.base}/api/voice/greeting`)).status, 404);
    assert.equal(off.fake.stt.length + off.fake.tts.length, 0, "a disabled engine is never called");
  } finally { await off.close(); }
});

test("POST /api/voice/transcribe: Henry vocabulary prompt, native script, stored as a talk transcript; text-only listing", async () => {
  const h = await harness("henry-talk-stt-");
  try {
    h.fake.transcript.current = "Henry, Codex का PR check करो";
    const response = await fetch(`${h.base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(tone(1600)) });
    assert.equal(response.status, 200);
    const data = await jsonOf(response);
    assert.equal(data.text, "Henry, Codex का PR check करो", "Whisper's native script is kept, not romanised");
    assert.match(String(data.transcriptId), /^[0-9a-f-]{36}$/);
    assert.equal(h.fake.stt.length, 1);
    assert.equal(h.fake.stt[0].language, "auto");
    for (const term of ["Henry", "Luvish", "Kelly", "Codex", "Claude", "Engram", "Luna"]) assert.ok(h.fake.stt[0].prompt?.includes(term), term);

    const list = await jsonOf(await fetch(`${h.base}/api/voice/transcripts`));
    const transcripts = list.transcripts as Array<Record<string, unknown>>;
    assert.equal(transcripts.length, 1);
    assert.equal(transcripts[0].surface, "talk");
    assert.equal(transcripts[0].text, "Henry, Codex का PR check करो");
    assert.equal(transcripts[0].durationSeconds, 0.1);
    assert.equal("audioPath" in transcripts[0], false, "no audio path leaves the server");
    const events = await h.runtime.activity.list(20);
    const logged = events.find((event) => event.kind === "voice.transcribed");
    assert.ok(logged);
    assert.doesNotMatch(JSON.stringify(logged), /Codex का/, "the words never land in the activity log");

    assert.equal((await fetch(`${h.base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/webm" }, body: new Uint8Array(tone()) })).status, 415);
    assert.equal((await fetch(`${h.base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(Buffer.from("not a wav file at all, definitely not RIFF data here....")) })).status, 400);
  } finally { await h.close(); }
});

test("POST /api/voice/transcribe in private mode keeps nothing", async () => {
  const h = await harness("henry-talk-stt-private-");
  try {
    updateSettings(h.runtime.config.settingsPath, { voice: { privateMode: true } });
    const data = await jsonOf(await fetch(`${h.base}/api/voice/transcribe`, { method: "POST", headers: { "content-type": "audio/wav" }, body: new Uint8Array(tone()) }));
    assert.equal(data.text, "what's the latest on Engram");
    assert.equal(data.transcriptId, undefined);
    assert.equal(data.private, true);
    const list = await jsonOf(await fetch(`${h.base}/api/voice/transcripts`));
    assert.deepEqual(list.transcripts, []);
    assert.equal((await h.runtime.activity.list(20)).some((event) => event.kind === "voice.transcribed"), false);
  } finally { await h.close(); }
});

test("POST /api/voice/speak: chunk framing, redaction before synthesis, private mode neutral line", async () => {
  const h = await harness("henry-talk-tts-");
  try {
    const response = await fetch(`${h.base}/api/voice/speak`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "Priya wrote from priya@example.com. Call her on +91 98765 43210! Nothing else.", chunk: true }),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/x-henry-wav-seq");
    const parts = frames(Buffer.from(await response.arrayBuffer()));
    assert.equal(parts.length, 3, "one WAV frame per sentence");
    for (const part of parts) assert.equal(part.subarray(0, 4).toString("ascii"), "RIFF");
    assert.equal(h.fake.tts.length, 3);
    const said = h.fake.tts.join(" ");
    assert.doesNotMatch(said, /priya@example\.com|98765|43210/, "private data never reaches the synthesiser");
    assert.match(said, /on your screen/);

    const single = await fetch(`${h.base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Done." }) });
    assert.equal(single.headers.get("content-type"), "audio/wav");
    assert.equal((await fetch(`${h.base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "  " }) })).status, 400);

    updateSettings(h.runtime.config.settingsPath, { voice: { privateMode: true } });
    h.fake.tts.length = 0;
    await (await fetch(`${h.base}/api/voice/speak`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "Your OTP is 482913 and Priya said yes.", chunk: true }) })).arrayBuffer();
    assert.deepEqual(h.fake.tts, [PRIVATE_SPOKEN_DONE]);
  } finally { await h.close(); }
});

test("speakableForRoute: private mode keeps the three neutral lines, replaces everything else", () => {
  const priv = { privateMode: true };
  assert.equal(speakableForRoute(PRIVATE_SPOKEN_WORKING, priv), PRIVATE_SPOKEN_WORKING);
  assert.equal(speakableForRoute(PRIVATE_SPOKEN_INPUT, priv), PRIVATE_SPOKEN_INPUT);
  assert.equal(speakableForRoute(PRIVATE_SPOKEN_DONE, priv), PRIVATE_SPOKEN_DONE);
  assert.equal(speakableForRoute("Should I send it?", priv), PRIVATE_SPOKEN_INPUT);
  assert.equal(speakableForRoute("Priya's number is 9876543210.", priv), PRIVATE_SPOKEN_DONE);
  assert.equal(speakableForRoute("Priya's number is 9876543210.", { privateMode: false }), "Priya's number is on your screen.");
});

test("GET /api/voice/greeting|reprompt|filler: Henry's phrases, synthesised once, cached on disk", async () => {
  const h = await harness("henry-talk-cache-");
  try {
    // A phrase already on disk is served from there without synthesis.
    const cacheDir = path.join(h.runtime.config.dataDir, "voice", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    const onDisk = tone(33);
    fs.writeFileSync(path.join(cacheDir, `${ttsPromptCacheHash(TALK_PHRASES.reprompt)}.wav`), onDisk);
    const reprompt = Buffer.from(await (await fetch(`${h.base}/api/voice/reprompt`)).arrayBuffer());
    assert.deepEqual(reprompt, onDisk);
    assert.equal(h.fake.tts.length, 0);

    for (let i = 0; i < 2; i++) {
      const greeting = await fetch(`${h.base}/api/voice/greeting`);
      assert.equal(greeting.status, 200);
      assert.equal(greeting.headers.get("content-type"), "audio/wav");
      await greeting.arrayBuffer();
    }
    assert.deepEqual(h.fake.tts, ["Hey Luvish. I'm listening."], "greeting synthesised exactly once");
    const hash = ttsPromptCacheHash(TALK_PHRASES.greeting);
    assert.ok(fs.existsSync(path.join(cacheDir, `${hash}.wav`)), "greeting cached on disk");

    await (await fetch(`${h.base}/api/voice/filler?v=0`)).arrayBuffer();
    await (await fetch(`${h.base}/api/voice/filler?v=1`)).arrayBuffer();
    await (await fetch(`${h.base}/api/voice/filler?v=${TALK_PHRASES.fillers.length}`)).arrayBuffer(); // wraps to v=0: cached
    assert.deepEqual(h.fake.tts.slice(1), TALK_PHRASES.fillers.slice(0, 2));
    // The two fillers played within one turn (v=0, v=1) are never the same line.
    assert.notEqual(TALK_PHRASES.fillers[0], TALK_PHRASES.fillers[1]);
    assert.ok(TALK_PHRASES.fillers.length >= 6 && TALK_PHRASES.fillers.length <= 10);
    assert.equal(TALK_PHRASES.reprompt, "Still here. What do you need?");
  } finally { await h.close(); }
});

test("ttsVoiceFromEnv: defaults to am_michael/1.0, parses and clamps HENRY_TTS_SPEED, and keys the prompt cache", () => {
  assert.deepEqual(ttsVoiceFromEnv({}), { voice: DEFAULT_TTS_VOICE, speed: DEFAULT_TTS_SPEED });
  assert.deepEqual(ttsVoiceFromEnv({ HENRY_TTS_VOICE: "  bm_lewis  " }), { voice: "bm_lewis", speed: DEFAULT_TTS_SPEED });
  assert.deepEqual(ttsVoiceFromEnv({ HENRY_TTS_SPEED: "0.9" }), { voice: DEFAULT_TTS_VOICE, speed: 0.9 });
  // Out-of-range and garbage speeds clamp/fall back instead of erroring.
  assert.deepEqual(ttsVoiceFromEnv({ HENRY_TTS_SPEED: "5" }), { voice: DEFAULT_TTS_VOICE, speed: 1.3 });
  assert.deepEqual(ttsVoiceFromEnv({ HENRY_TTS_SPEED: "0.01" }), { voice: DEFAULT_TTS_VOICE, speed: 0.7 });
  assert.deepEqual(ttsVoiceFromEnv({ HENRY_TTS_SPEED: "not-a-number" }), { voice: DEFAULT_TTS_VOICE, speed: DEFAULT_TTS_SPEED });

  // A changed voice or speed changes the cache key, so an old cached clip is never replayed.
  const text = "Hey. I'm listening.";
  const base = ttsPromptCacheHash(text, {});
  assert.notEqual(base, ttsPromptCacheHash(text, { HENRY_TTS_VOICE: "bm_lewis" }));
  assert.notEqual(base, ttsPromptCacheHash(text, { HENRY_TTS_SPEED: "1.2" }));
  assert.equal(base, ttsPromptCacheHash(text, {}));
});

test("GET /vendor/vad/<name>: allowlisted assets only; traversal and unknown names 404", async () => {
  const h = await harness("henry-talk-vendor-");
  try {
    const bundle = await fetch(`${h.base}/vendor/vad/bundle.min.js`);
    assert.equal(bundle.status, 200);
    assert.match(String(bundle.headers.get("content-type")), /javascript/);
    assert.ok((await bundle.arrayBuffer()).byteLength > 1000);
    const model = await fetch(`${h.base}/vendor/vad/silero_vad_v5.onnx`);
    assert.equal(model.status, 200);
    await model.arrayBuffer();
    const wasm = await fetch(`${h.base}/vendor/vad/ort-wasm-simd-threaded.wasm`);
    assert.equal(wasm.headers.get("content-type"), "application/wasm");
    await wasm.arrayBuffer();
    for (const name of ["package.json", "..%2Fpackage.json", "%2e%2e%2f%2e%2e%2fpackage.json", "bundle.min.js%00", "constructor", "__proto__", "%E0%A4%A"]) {
      const response = await fetch(`${h.base}/vendor/vad/${name}`);
      assert.equal(response.status, 404, name);
      await response.arrayBuffer();
    }
    assert.equal(await vendorVadAsset("../../package.json"), null);
    assert.equal(await vendorVadAsset("hasOwnProperty"), null);
  } finally { await h.close(); }
});

test("GET/POST /api/voice/settings: same-origin writes, allowWrites kept beside the voice settings, retention clamped", async () => {
  const h = await harness("henry-talk-settings-");
  try {
    const initial = await jsonOf(await fetch(`${h.base}/api/voice/settings`));
    assert.equal((initial.settings as Record<string, unknown>).privateMode, false);
    assert.equal((initial.settings as Record<string, unknown>).allowWrites, false);
    assert.equal((initial.settings as Record<string, unknown>).retentionDays, 60);

    const crossOrigin = await fetch(`${h.base}/api/voice/settings`, {
      method: "POST", headers: { "content-type": "application/json", origin: "https://evil.example" }, body: JSON.stringify({ allowWrites: true }),
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(readSettings(h.runtime.config.settingsPath).voice, undefined, "a cross-origin write changes nothing");

    const saved = await jsonOf(await fetch(`${h.base}/api/voice/settings`, {
      method: "POST", headers: { "content-type": "application/json", origin: h.base },
      body: JSON.stringify({ privateMode: true, allowWrites: true, retentionDays: 30 }),
    }));
    assert.deepEqual(saved.effective, { privateMode: true, allowWrites: true });
    const voice = readSettings(h.runtime.config.settingsPath).voice as Record<string, unknown>;
    assert.equal(voice.allowWrites, true);
    assert.equal(voice.privateMode, true);
    assert.equal(voice.retentionDays, 30);

    const clamped = await jsonOf(await fetch(`${h.base}/api/voice/settings`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ retentionDays: 9999, allowWrites: false }),
    }));
    assert.equal((clamped.settings as Record<string, unknown>).retentionDays, 365);
    assert.equal((clamped.settings as Record<string, unknown>).allowWrites, false);
    assert.equal((clamped.settings as Record<string, unknown>).privateMode, true, "an unrelated key survives");
    assert.ok((await h.runtime.activity.list(20)).some((event) => event.kind === "voice.settings.updated"));
  } finally { await h.close(); }
});

test("POST /api/voice/talk/session records talk.session.started/ended", async () => {
  const h = await harness("henry-talk-session-");
  try {
    const post = (payload: unknown) => fetch(`${h.base}/api/voice/talk/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
    assert.equal((await post({ event: "start" })).status, 200);
    assert.equal((await post({ event: "end", turns: 3, reason: "sleep" })).status, 200);
    assert.equal((await post({ event: "bogus" })).status, 400);
    const events = await h.runtime.activity.list(20);
    assert.ok(events.some((event) => event.kind === "talk.session.started"));
    const ended = events.find((event) => event.kind === "talk.session.ended");
    assert.deepEqual(ended?.metadata, { voice: true, turns: 3, reason: "sleep" });
  } finally { await h.close(); }
});

test("Talk entry points: /talk page, the dashboard rail link and voice card, the chat overlay", async () => {
  const h = await harness("henry-talk-pages-");
  try {
    const talk = await fetch(`${h.base}/talk`, { headers: { accept: "text/html" } });
    assert.equal(talk.status, 200);
    const html = await talk.text();
    assert.match(html, /window\.HenryTalk/);
    assert.match(html, /henry\.voice\.conversationId/);
    assert.match(html, /\/vendor\/vad\/bundle\.min\.js/);
    assert.doesNotMatch(html, /showcase|designs|lehenga|fonts\.googleapis/i, "no shop copy, no remote fonts");
    const dashboard = await (await fetch(`${h.base}/`)).text();
    assert.match(dashboard, /<a class="link" href="\/talk">talk ↗<\/a>/);
    assert.match(dashboard, /id="voice-card"/);
    assert.match(dashboard, /Voice can stage drafts; approvals and sends stay typed\./);
    const chat = await (await fetch(`${h.base}/chat`)).text();
    assert.match(chat, /id="openTalk"/);
    assert.match(chat, /\/talk\?embed=1&captions=1/);
    assert.match(chat, /talkFrame\.src = "about:blank"/);
  } finally { await h.close(); }
});

test("voiceVocabularyPrompt appends local terms from HENRY_VOICE_VOCABULARY", () => {
  const prompt = voiceVocabularyPrompt({ HENRY_VOICE_VOCABULARY: "Orbit, Henry , Pixel" });
  assert.match(prompt, /Orbit/);
  assert.match(prompt, /Pixel/);
  assert.equal(prompt.match(/Henry/g)?.length, 2, "Henry appears in the lead-in and once in the list");
  assert.ok(prompt.length <= 400, "fits whisper's prompt cap");
});

// ---------------------------------------------------------------------------
// `gathering` SSE: fillers only for lookups
// ---------------------------------------------------------------------------

test("gathering: request-shaped voice turn signals up front, once, before the answer", async () => {
  const h = await harness("henry-talk-gather-req-");
  try {
    h.script.current = (emit) => {
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.started", item: { type: "web_search" } } });
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "agent_message", text: "```spoken\nTwo updates.\n```\nDetails." } } });
      return "```spoken\nTwo updates.\n```\nDetails.";
    };
    const events = await send(h.base, { prompt: "what's the latest on Engram", voice: true });
    const gathering = events.filter((entry) => entry.event === "gathering");
    assert.deepEqual(gathering.map((entry) => entry.data), [{ reason: "request" }], "exactly one, reason request");
    const names = events.map((entry) => entry.event);
    assert.ok(names.indexOf("gathering") < names.indexOf("spoken"));
    assert.ok(names.indexOf("gathering") < names.indexOf("done"));
  } finally { await h.close(); }
});

test("gathering: chit-chat gets none; a tool start mid-turn signals reason tool (Codex and Claude)", async () => {
  const h = await harness("henry-talk-gather-tool-");
  try {
    h.script.current = (emit) => { emit({ timestamp: "", stream: "stdout", text: "", parsed: { text: "Hey!" } }); return "Hey!"; };
    const chat = await send(h.base, { prompt: "hi Henry, how are you", voice: true });
    assert.equal(chat.some((entry) => entry.event === "gathering"), false, "chit-chat never gathers");

    h.script.current = (emit) => {
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.started", item: { type: "command_execution", command: "cat secrets.txt" } } });
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "command_execution" } } });
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "agent_message", text: "Done." } } });
      return "Done.";
    };
    const codex = await send(h.base, { prompt: "tell me about the build", voice: true });
    const codexGathering = codex.filter((entry) => entry.event === "gathering");
    assert.deepEqual(codexGathering.map((entry) => entry.data), [{ reason: "tool" }]);
    assert.doesNotMatch(JSON.stringify(codexGathering), /secrets/, "the event never carries the command");

    h.script.current = (emit) => {
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "assistant", message: { content: [{ type: "tool_use", name: "WebSearch", input: { query: "x" } }] } } });
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "assistant", message: { content: [{ type: "text", text: "Found it." }] } } });
      return "Found it.";
    };
    const claude = await send(h.base, { prompt: "tell me about the build", voice: true });
    assert.deepEqual(claude.filter((entry) => entry.event === "gathering").map((entry) => entry.data), [{ reason: "tool" }]);
  } finally { await h.close(); }
});

test("gathering: typed turns never get it, even for lookups with tools", async () => {
  const h = await harness("henry-talk-gather-typed-");
  try {
    h.script.current = (emit) => {
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.started", item: { type: "web_search" } } });
      emit({ timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "agent_message", text: "News." } } });
      return "News.";
    };
    const events = await send(h.base, { prompt: "search the news about Codex" });
    assert.equal(events.some((entry) => entry.event === "gathering"), false);
    assert.equal(events.at(-1)?.event, "done");
  } finally { await h.close(); }
});
