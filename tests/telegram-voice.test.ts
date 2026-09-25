import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import { ActivityLog } from "../src/activity.ts";
import { TelegramBridge, type BridgeVoice, type BridgeVoicePolicy } from "../src/telegram/bridge.ts";
import type { PumpMetaStore, TelegramAudioMeta, TelegramUpdate } from "../src/telegram/pump.ts";
import {
  TelegramVoiceIntake, VoiceIntakeError, telegramVoiceReplier,
  type AudioConverter, type TelegramFileFetcher, type TelegramFileInfo, type VoiceTranscriber,
} from "../src/telegram/voice.ts";
import { updateSettings } from "../src/util/settings.ts";

/**
 * OWNER VOICE NOTES — Henry acts DIRECTLY on a transcript (no typed "yes" gate, unlike
 * Kelly), but every voice turn still rides the same read-only + HENRY_VOICE_TURN rail a
 * spoken dashboard turn gets (src/voice/policy.ts): `deps.think` is always called with
 * `{ voice: true }` for a transcript, which is what the runtime wiring uses to attach
 * `voice: { privateMode, allowWrites }` to agent.run. Nothing here calls an approval
 * executor at all, so a spoken "approve it" has no execution path to reach.
 *
 * Every Telegram call is faked. No test opens a socket, spawns ffmpeg, or touches a bot.
 */

const OWNER_CHAT = "12345";
const FOREIGN_CHAT = "999888";

function tempConfig(overrides: Partial<HenryConfig> = {}): HenryConfig {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "henry-tgvoice-"));
  const config = loadConfig(root);
  config.telegramBotToken = "test-token";
  config.telegramChatId = OWNER_CHAT;
  config.telegramStandupChatId = undefined;
  return Object.assign(config, overrides);
}

function memoryStore(): PumpMetaStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getMeta: (key) => map.get(key),
    setMeta: (key, value) => void map.set(key, value),
    deleteMeta: (key) => void map.delete(key),
  };
}

const VOICE_META: TelegramAudioMeta = { file_id: "file-abc", duration: 4, mime_type: "audio/ogg", file_size: 8_000 };

function voiceUpdate(updateId: number, chatId = OWNER_CHAT, meta: TelegramAudioMeta = VOICE_META, extra: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000),
      voice: meta,
      chat: { id: Number(chatId), type: "private" },
      from: { id: 7, first_name: "Luvish" },
      ...extra,
    },
  };
}

function textUpdate(updateId: number, text: string, chatId = OWNER_CHAT): TelegramUpdate {
  return {
    update_id: updateId,
    message: {
      message_id: updateId, date: Math.floor(Date.now() / 1000), text,
      chat: { id: Number(chatId), type: "private" },
      from: { id: 7, first_name: "Luvish" },
    },
  };
}

interface ThinkCall { prompt: string; voice: boolean }
interface Harness {
  bridge: TelegramBridge;
  sent: string[];
  asked: ThinkCall[];
  transcribed: TelegramAudioMeta[];
  store: PumpMetaStore & { map: Map<string, string> };
  activity: ActivityLog;
  config: HenryConfig;
  clock: { now: number };
  spoken: string[];
  settles: Array<{ id: string | undefined; state: string; reply?: string }>;
}

async function harness(options: {
  transcript?: string | (() => Promise<{ text: string; bytes: number }>);
  voiceEnabled?: boolean;
  withVoice?: boolean;
  privateMode?: boolean;
  allowWrites?: boolean;
  store?: PumpMetaStore & { map: Map<string, string> };
  config?: HenryConfig;
  speak?: "ok" | "fail";
  answer?: (prompt: string) => string;
} = {}): Promise<Harness> {
  const config = options.config ?? tempConfig();
  const activity = new ActivityLog(config.activityPath);
  await activity.init();
  const sent: string[] = [];
  const asked: ThinkCall[] = [];
  const transcribed: TelegramAudioMeta[] = [];
  const store = options.store ?? memoryStore();
  const clock = { now: Date.now() };
  const spoken: string[] = [];
  const settles: Array<{ id: string | undefined; state: string; reply?: string }> = [];
  const policy: BridgeVoicePolicy = { privateMode: options.privateMode === true, allowWrites: options.allowWrites === true };
  const voice: BridgeVoice = {
    enabled: options.voiceEnabled !== false,
    ...(options.speak
      ? { speak: async (text: string) => { spoken.push(text); return options.speak !== "fail"; } }
      : {}),
    async transcribe(meta: TelegramAudioMeta) {
      transcribed.push(meta);
      const id = `voice-${transcribed.length}`;
      if (typeof options.transcript === "function") return { ...(await options.transcript()), language: "hi", id };
      return { text: options.transcript ?? "quote a 20W batten ka rate", language: "hi", bytes: 8_000, durationSeconds: 4, id };
    },
    policy: () => policy,
    settle: (id, state, reply) => { settles.push({ id, state, reply }); },
  };
  const bridge = new TelegramBridge(config, activity, store, {
    think: async (prompt, _report, context) => { asked.push({ prompt, voice: context?.voice === true }); return options.answer ? options.answer(prompt) : `answered: ${prompt}`; },
    send: async (_config, text) => { sent.push(text); return true; },
    now: () => clock.now,
    fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
    ...(options.withVoice === false ? {} : { voice }),
  });
  return { bridge, sent, asked, transcribed, store, activity, config, clock, spoken, settles };
}

/* ------------------------------------------------------------------ *
 * 1. The owner rail
 * ------------------------------------------------------------------ */

test("a voice note from an unknown chat reaches nothing: no download, no transcript, no reply, no log", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1, FOREIGN_CHAT)]);
  await h.bridge.settled();

  assert.deepEqual(h.transcribed, [], "an unknown chat must never reach transcription");
  assert.deepEqual(h.sent, [], "and must never get a reply");
  assert.equal(h.bridge.stats().voiceReceived, 0);
  const logged = (await h.activity.list(50)).map((event) => `${event.kind} ${event.message}`).join("\n");
  assert.ok(!/voice/i.test(logged), "an unknown chat's media is never described in the log");
});

test("the owner's voice note becomes a VOICE TURN: transcript is echoed, then run directly with voice context", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.equal(h.transcribed.length, 1);
  assert.equal(h.asked.length, 1, "the transcript runs immediately — no typed confirmation step");
  assert.equal(h.asked[0].prompt, "quote a 20W batten ka rate");
  assert.equal(h.asked[0].voice, true, "think() is called with the voice context, forcing the read-only rail");

  // The transcript is echoed back before the turn runs, then the text answer follows.
  assert.equal(h.sent[0], 'You said: "quote a 20W batten ka rate"');
  assert.equal(h.sent[1], "answered: quote a 20W batten ka rate");
  assert.equal(h.bridge.stats().voiceTranscribed, 1);
  assert.equal(h.bridge.stats().replies, 1);
  assert.deepEqual(h.settles, [{ id: "voice-1", state: "answered", reply: "answered: quote a 20W batten ka rate" }]);
});

test("a voice note saying \"approve it\" executes nothing: it is only ever passed to think() as a read-only voice turn", async () => {
  const h = await harness({ transcript: "approve request-42 and send it now" });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].prompt, "approve request-42 and send it now");
  assert.equal(h.asked[0].voice, true, "the words reach the brain only inside the voice-turn rail, never an approval executor");
  // The bridge itself exposes no approval-execution surface at all — there is nothing for
  // the transcript's words to invoke directly, voice or otherwise.
  assert.equal(("approve" in h.bridge), false);
});

test("ordinary text — including a typed approval-shaped message — runs exactly as it does today (no voice context)", async () => {
  const h = await harness();
  await h.bridge.consume([textUpdate(1, "approve request-42")]);
  await h.bridge.settled();

  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].prompt, "approve request-42");
  assert.equal(h.asked[0].voice, false, "a typed message is never a voice turn");
  assert.equal(h.sent[0], "answered: approve request-42");
});

/* ------------------------------------------------------------------ *
 * 2. Bounded intake, failures, and the plain-error rail
 * ------------------------------------------------------------------ */

test("a failed transcription (download/convert/transcribe) answers with one plain line and never reaches the brain", async () => {
  const h = await harness({
    transcript: async () => { throw new VoiceIntakeError("I could not convert that audio (ffmpeg missing).", "conversion_failed"); },
  });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /could not convert that audio/);
  assert.deepEqual(h.asked, []);
  assert.equal(h.bridge.stats().voiceRejected, 1);
  const failure = (await h.activity.list(50)).find((event) => event.kind === "voice.failed");
  assert.ok(failure, "the failure is recorded");
  assert.equal(failure?.metadata?.code, "conversion_failed");
});

test("without local transcription configured the note is declined in one sentence", async () => {
  const h = await harness({ withVoice: false });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0], /cannot transcribe voice notes/);
  assert.deepEqual(h.asked, []);
});

test("an error carrying a URL/token is redacted before it reaches the chat or the log", async () => {
  const h = await harness({
    transcript: async () => { throw new Error("download failed from https://api.telegram.org/file/bot123:SECRET/voice/a.oga"); },
  });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.equal(h.sent.length, 1);
  assert.ok(!h.sent[0].includes("SECRET"), "a token never reaches the chat");
  assert.ok(!h.sent[0].includes("https://"), "and neither does the URL");
  const serialized = JSON.stringify(await h.activity.list(50));
  assert.ok(!serialized.includes("SECRET"), "the bot token never reaches the log");
  assert.ok(!serialized.includes("file-abc"), "the Telegram file id never reaches the log");
});

test("a stale voice note is counted and dropped without transcription", async () => {
  const h = await harness();
  const stale = voiceUpdate(1);
  stale.message!.date = Math.floor(Date.now() / 1000) - 48 * 60 * 60;
  await h.bridge.consume([stale]);
  await h.bridge.settled();
  assert.deepEqual(h.transcribed, []);
  assert.equal(h.bridge.stats().stale, 1);
});

test("an edited voice message is not transcribed again", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  assert.equal(h.transcribed.length, 1);

  const edit: TelegramUpdate = { update_id: 2, edited_message: voiceUpdate(1).message };
  await h.bridge.consume([edit]);
  await h.bridge.settled();

  assert.equal(h.transcribed.length, 1, "the same audio is never transcribed twice");
});

test("ordinary typed text still works unchanged while voice is wired", async () => {
  const h = await harness();
  await h.bridge.consume([textUpdate(1, "what is the price of a 20W batten?")]);
  await h.bridge.settled();
  assert.equal(h.asked.length, 1);
  assert.equal(h.asked[0].prompt, "what is the price of a 20W batten?");
  assert.equal(h.asked[0].voice, false);
  assert.equal(h.sent[0], "answered: what is the price of a 20W batten?");
  assert.equal(h.bridge.stats().voiceReceived, 0);
});

/* ------------------------------------------------------------------ *
 * 3. Spoken replies and private mode
 * ------------------------------------------------------------------ */

test("a voice turn is answered in text and then spoken", async () => {
  const h = await harness({ speak: "ok" });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  const answer = h.sent.find((text) => text.startsWith("answered:"));
  assert.ok(answer, "the text answer is always sent");
  assert.deepEqual(h.spoken, [answer], "with no ```spoken fence, the whole short answer is spoken, built via speakableSummary + finalizeSpoken");
  assert.equal(h.bridge.stats().voiceSpoken, 1);
});

test("a typed turn is never spoken back", async () => {
  const h = await harness({ speak: "ok" });
  await h.bridge.consume([textUpdate(1, "what is the rate of a 9W bulb?")]);
  await h.bridge.settled();
  assert.equal(h.asked.length, 1);
  assert.deepEqual(h.spoken, [], "speech is offered only for a turn the owner spoke");
});

test("private mode sends no voice at all, and records nothing", async () => {
  const h = await harness({ speak: "ok", privateMode: true });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.ok(h.sent.some((text) => text.startsWith("answered:")), "the text answer still stands");
  assert.deepEqual(h.spoken, [], "private mode speaks nothing, not even a neutral line");
  assert.equal(h.bridge.stats().voiceSpoken, 0);

  // Recording is the injected implementation's job (VoiceTranscriptStore.record() itself
  // no-ops under settings.voice.privateMode) — verified end-to-end against the real store.
  const { VoiceTranscriptStore } = await import("../src/voice/transcripts.ts");
  updateSettings(h.config.settingsPath, { voice: { privateMode: true } });
  const store = new VoiceTranscriptStore(h.config.dataDir, h.config.settingsPath);
  try {
    store.record({ surface: "telegram", text: "quote a 20W batten ka rate" });
    assert.deepEqual(store.list({ surface: "telegram" }), [], "private mode persists nothing");
  } finally {
    store.close();
  }
});

test("a failed spoken reply is silent: the text answer still stands", async () => {
  const h = await harness({ speak: "fail" });
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();

  assert.ok(h.sent.some((text) => text.startsWith("answered:")), "the owner still has the answer");
  assert.equal(h.bridge.stats().voiceSpoken, 0, "a failed voice reply is not counted");
  assert.equal(h.bridge.stats().failed, 0, "and is never reported as a turn failure");
});

test("without the opt-in speaker nothing is spoken", async () => {
  const h = await harness();
  await h.bridge.consume([voiceUpdate(1)]);
  await h.bridge.settled();
  assert.deepEqual(h.spoken, []);
  assert.equal(h.bridge.stats().voiceSpoken, 0);
});

/* ------------------------------------------------------------------ *
 * 4. The intake: bounded before, during and after the download
 * ------------------------------------------------------------------ */

function fakeIntake(options: {
  file?: TelegramFileInfo;
  bytes?: Buffer;
  download?: (file: TelegramFileInfo, maxBytes: number) => Promise<Buffer>;
  convert?: (input: Buffer) => Promise<Buffer>;
  transcribe?: (wav: Uint8Array) => Promise<{ text: string }>;
  sttEnabled?: boolean;
  limits?: { maxBytes?: number; maxSeconds?: number; prompt?: string };
} = {}): { intake: TelegramVoiceIntake; calls: { getFile: number; download: number; convert: number; transcribe: number }; transcribeOptions: Array<{ language?: string; prompt?: string }> } {
  const calls = { getFile: 0, download: 0, convert: 0, transcribe: 0 };
  const transcribeOptions: Array<{ language?: string; prompt?: string }> = [];
  const fetcher: TelegramFileFetcher = {
    async getFile() { calls.getFile += 1; return options.file ?? { filePath: "voice/file_1.oga", fileSize: 8_000 }; },
    async download(file, maxBytes) {
      calls.download += 1;
      if (options.download) return await options.download(file, maxBytes);
      return options.bytes ?? Buffer.from("opus-bytes");
    },
  };
  const converter: AudioConverter = {
    async toWav16kMono(input) {
      calls.convert += 1;
      if (options.convert) return await options.convert(input);
      return Buffer.from("RIFFfake");
    },
  };
  const transcriber: VoiceTranscriber = {
    sttEnabled: () => options.sttEnabled !== false,
    async transcribe(wav, transcribeOpts) {
      calls.transcribe += 1;
      transcribeOptions.push(transcribeOpts ?? {});
      if (options.transcribe) return await options.transcribe(wav);
      return { text: "  ek 20W batten ka rate  ", language: "hi" };
    },
  };
  return { intake: new TelegramVoiceIntake({ fetcher, converter, transcriber, limits: options.limits }), calls, transcribeOptions };
}

test("intake screens size, duration and format BEFORE any Telegram call", async () => {
  const cases: Array<[TelegramAudioMeta, string]> = [
    [{ file_id: "a", file_size: 50 * 1024 * 1024 }, "too_large"],
    [{ file_id: "a", duration: 9_000 }, "too_long"],
    [{ file_id: "a", mime_type: "video/mp4" }, "unsupported_media"],
    [{ file_id: "" }, "unsupported_media"],
  ];
  for (const [meta, code] of cases) {
    const { intake, calls } = fakeIntake();
    await assert.rejects(() => intake.transcribe(meta), (error: VoiceIntakeError) => {
      assert.equal(error.code, code);
      return true;
    });
    assert.equal(calls.getFile, 0, `${code}: nothing is fetched`);
    assert.equal(calls.download, 0, `${code}: nothing is downloaded`);
  }
});

test("intake enforces the byte cap again during and after the download", async () => {
  const oversizedStream = fakeIntake({
    download: async (_file, maxBytes) => { throw new VoiceIntakeError(`over ${maxBytes}`, "too_large"); },
  });
  await assert.rejects(() => oversizedStream.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "too_large");

  const liar = fakeIntake({ bytes: Buffer.alloc(2_048), limits: { maxBytes: 1_024 } });
  await assert.rejects(() => liar.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "too_large");
  assert.equal(liar.calls.convert, 0, "oversized audio never reaches the converter");

  const bigFile = fakeIntake({ file: { filePath: "voice/x.oga", fileSize: 9_999 }, limits: { maxBytes: 1_000 } });
  await assert.rejects(() => bigFile.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "too_large");
  assert.equal(bigFile.calls.download, 0);
});

test("intake maps conversion, transcription and empty-transcript failures to codes", async () => {
  const conversion = fakeIntake({ convert: async () => { throw new Error("ffmpeg exited 1"); } });
  await assert.rejects(() => conversion.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "conversion_failed");

  const stt = fakeIntake({ transcribe: async () => { throw new Error("whisper exploded"); } });
  await assert.rejects(() => stt.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "transcription_failed");

  const silent = fakeIntake({ transcribe: async () => ({ text: "   " }) });
  await assert.rejects(() => silent.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "transcription_failed");

  const disabled = fakeIntake({ sttEnabled: false });
  await assert.rejects(() => disabled.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => error.code === "disabled");
  assert.equal(disabled.calls.getFile, 0, "a disabled adapter never calls Telegram");
});

test("intake never leaks a token or URL into an error message", async () => {
  const leaky = fakeIntake({
    convert: async () => { throw new Error("failed at https://api.telegram.org/file/bot123:SECRET/voice/file_1.oga"); },
  });
  await assert.rejects(() => leaky.intake.transcribe({ file_id: "a" }), (error: VoiceIntakeError) => {
    assert.ok(!error.message.includes("SECRET"), "the token never rides out inside an error");
    assert.ok(!error.message.includes("https://"), "and neither does the URL");
    assert.match(error.message, /\[url\]/);
    return true;
  });
});

test("the real Telegram file fetcher never puts the bot token in a thrown message", async () => {
  const { httpTelegramFileFetcher } = await import("../src/telegram/voice.ts");
  const token = "123456:SUPER-SECRET-TOKEN";
  const fetchImpl = (async () => new Response("not json", { status: 500 })) as unknown as typeof fetch;
  const fetcher = httpTelegramFileFetcher(token, fetchImpl);
  await assert.rejects(() => fetcher.getFile("file-1"), (error: Error) => {
    assert.ok(!error.message.includes(token), "the token is never part of a thrown error");
    return true;
  });
});

test("intake returns the trimmed transcript with the bytes it actually read", async () => {
  const { intake, calls } = fakeIntake({ bytes: Buffer.alloc(1_234) });
  const result = await intake.transcribe({ file_id: "a", duration: 6 });
  assert.equal(result.text, "ek 20W batten ka rate");
  assert.equal(result.bytes, 1_234);
  assert.equal(result.durationSeconds, 6);
  assert.deepEqual(calls, { getFile: 1, download: 1, convert: 1, transcribe: 1 });
});

test("intake passes a configured vocabulary prompt through to the transcriber, and omits it when none is set", async () => {
  const withPrompt = fakeIntake({ limits: { prompt: "Henry, Luvish, Telegram, dashboard" } });
  await withPrompt.intake.transcribe({ file_id: "a" });
  assert.equal(withPrompt.transcribeOptions[0].prompt, "Henry, Luvish, Telegram, dashboard");

  const withoutPrompt = fakeIntake();
  await withoutPrompt.intake.transcribe({ file_id: "a" });
  assert.equal(withoutPrompt.transcribeOptions[0].prompt, undefined);
});

test("telegramVoiceReplier always pins language 'en', even for Devanagari text", async () => {
  const calls: Array<{ text: string; language?: string }> = [];
  const speak = telegramVoiceReplier({
    synthesize: async (text, options) => { calls.push({ text, language: options?.language }); return Buffer.from("wav"); },
    encode: async (wav) => wav,
    send: async () => true,
  });
  assert.equal(await speak("Two suits, total 1700 rupees."), true);
  assert.equal(await speak("दो सूट, कुल 1700 रुपये।"), true);
  assert.deepEqual(calls.map((call) => call.language), ["en", "en"]);
});
