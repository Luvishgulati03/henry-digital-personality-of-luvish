import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  LocalVoiceService,
  VoiceError,
  voiceConfigFromEnv,
  runVoiceCommand,
  type VoiceCommandRunner,
} from "../src/voice/index.ts";
import {
  VOICE_SETTINGS_DEFAULTS,
  VoiceTranscriptStore,
  readVoiceSettings,
  updateVoiceSettings,
} from "../src/voice/transcripts.ts";
import { hasDevanagari, toRomanHinglish } from "../src/voice/roman.ts";
import { DEFAULT_KELLY_ROOT, VOICE_MODEL_FILES, resolveVoicePaths } from "../src/voice/resolve.ts";

async function tmpDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/* ------------------------------------------------------------------ *
 * LocalVoiceService config from HENRY_ env
 * ------------------------------------------------------------------ */

test("voiceConfigFromEnv reads HENRY_-prefixed variables", () => {
  const env = {
    HENRY_WHISPER_CPP_PATH: "/opt/homebrew/bin/whisper-cli",
    HENRY_WHISPER_MODEL_PATH: "/models/ggml-small-q5_1.bin",
    HENRY_KOKORO_URL: "http://127.0.0.1:8766",
    HENRY_KOKORO_TOKEN: "a".repeat(32),
  } as NodeJS.ProcessEnv;
  const config = voiceConfigFromEnv(env);
  assert.equal(config.stt?.whisperCppPath, "/opt/homebrew/bin/whisper-cli");
  assert.equal(config.stt?.whisperModelPath, "/models/ggml-small-q5_1.bin");
  assert.equal(config.tts?.engine, "kokoro");
  assert.equal(config.tts?.url, "http://127.0.0.1:8766");
  assert.equal(config.tts?.token, "a".repeat(32));

  const service = new LocalVoiceService(config);
  assert.equal(service.sttEnabled(), true);
  assert.equal(service.ttsEnabled(), true);
});

test("voiceConfigFromEnv leaves stt/tts undefined when nothing is set", () => {
  const config = voiceConfigFromEnv({} as NodeJS.ProcessEnv);
  assert.equal(config.stt, undefined);
  assert.equal(config.tts, undefined);
});

test("voiceConfigFromEnv reads HENRY_TTS_ENGINE and HENRY_TTS_EXECUTABLE/MODEL_PATH for espeak/piper", () => {
  const config = voiceConfigFromEnv({
    HENRY_TTS_ENGINE: "espeak-ng",
    HENRY_TTS_EXECUTABLE: "/usr/bin/espeak-ng",
  } as NodeJS.ProcessEnv);
  assert.equal(config.tts?.engine, "espeak-ng");
  assert.equal(config.tts?.executablePath, "/usr/bin/espeak-ng");

  const piper = voiceConfigFromEnv({
    HENRY_TTS_ENGINE: "piper",
    HENRY_TTS_EXECUTABLE: "/usr/bin/piper",
    HENRY_TTS_MODEL_PATH: "/models/piper.onnx",
  } as NodeJS.ProcessEnv);
  assert.equal(piper.tts?.modelPath, "/models/piper.onnx");
});

/* ------------------------------------------------------------------ *
 * whisper args include --prompt when given
 * ------------------------------------------------------------------ */

test("transcribe passes --prompt (sanitized) to whisper-cli when a prompt is given", async () => {
  const calls: Array<{ executable: string; args: string[] }> = [];
  const dir = await tmpDir("henry-voice-test-");
  const runner: VoiceCommandRunner = async (executable, args, options) => {
    calls.push({ executable, args });
    if (options.maxFilePath) await fs.writeFile(options.maxFilePath, "hello world\n");
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const service = new LocalVoiceService({
    stt: { whisperCppPath: "/opt/homebrew/bin/whisper-cli", whisperModelPath: "/models/ggml-small-q5_1.bin" },
    tempRoot: dir,
  }, runner);

  // Minimal valid mono 16-bit PCM WAV, 1 sample.
  const wav = makeWav();
  const result = await service.transcribe(wav, { language: "en", prompt: 'quote"s\nand\nnewlines' });
  assert.equal(result.text, "hello world");
  const args = calls[0].args;
  const promptIndex = args.indexOf("--prompt");
  assert.notEqual(promptIndex, -1, "expected --prompt to be passed");
  assert.equal(args[promptIndex + 1], "quotes and newlines");
});

test("transcribe omits --prompt when none is given", async () => {
  const calls: Array<{ args: string[] }> = [];
  const dir = await tmpDir("henry-voice-test-");
  const runner: VoiceCommandRunner = async (_executable, args, options) => {
    calls.push({ args });
    if (options.maxFilePath) await fs.writeFile(options.maxFilePath, "hi\n");
    return { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), exitCode: 0 };
  };
  const service = new LocalVoiceService({
    stt: { whisperCppPath: "/opt/homebrew/bin/whisper-cli", whisperModelPath: "/models/ggml-small-q5_1.bin" },
    tempRoot: dir,
  }, runner);
  await service.transcribe(makeWav(), { language: "en" });
  assert.ok(!calls[0].args.includes("--prompt"));
});

/* ------------------------------------------------------------------ *
 * Kokoro URL must be loopback
 * ------------------------------------------------------------------ */

test("Kokoro TTS is disabled unless the URL is loopback http://", () => {
  const remote = new LocalVoiceService({ tts: { engine: "kokoro", url: "http://example.com", token: "a".repeat(32) } });
  assert.equal(remote.ttsEnabled(), false);

  const https = new LocalVoiceService({ tts: { engine: "kokoro", url: "https://127.0.0.1:8766", token: "a".repeat(32) } });
  assert.equal(https.ttsEnabled(), false);

  const loopback = new LocalVoiceService({ tts: { engine: "kokoro", url: "http://127.0.0.1:8766", token: "a".repeat(32) } });
  assert.equal(loopback.ttsEnabled(), true);
});

test("synthesize rejects a non-loopback Kokoro URL even if called directly", async () => {
  const service = new LocalVoiceService({ tts: { engine: "kokoro", url: "http://evil.example.com", token: "a".repeat(32) } });
  await assert.rejects(() => service.synthesize("hello"), (error: unknown) => error instanceof VoiceError && error.code === "disabled");
});

function makeWav(): Buffer {
  const sampleRate = 16000;
  const samples = 1;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28); // byte rate
  buffer.writeUInt16LE(2, 32); // block align
  buffer.writeUInt16LE(16, 34); // bits per sample
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  buffer.writeInt16LE(0, 44);
  return buffer;
}

/* ------------------------------------------------------------------ *
 * Transcript store: retention + the two new settings, with defaults
 * ------------------------------------------------------------------ */

test("VOICE_SETTINGS_DEFAULTS keeps 60d text retention, audio off, talk on, private mode off", () => {
  assert.equal(VOICE_SETTINGS_DEFAULTS.retentionDays, 60);
  assert.equal(VOICE_SETTINGS_DEFAULTS.recordAudio, false);
  assert.equal(VOICE_SETTINGS_DEFAULTS.talkEnabled, true);
  assert.equal(VOICE_SETTINGS_DEFAULTS.privateMode, false);
});

test("readVoiceSettings returns defaults when settings.json has no voice key", async () => {
  const dir = await tmpDir("henry-voice-settings-");
  const settingsPath = path.join(dir, "settings.json");
  const settings = readVoiceSettings(settingsPath);
  assert.deepEqual(settings, VOICE_SETTINGS_DEFAULTS);
});

test("updateVoiceSettings persists talkEnabled/privateMode and drops unknown legacy keys", async () => {
  const dir = await tmpDir("henry-voice-settings-");
  const settingsPath = path.join(dir, "settings.json");
  const next = updateVoiceSettings(settingsPath, { talkEnabled: false, privateMode: true });
  assert.equal(next.talkEnabled, false);
  assert.equal(next.privateMode, true);
  const reread = readVoiceSettings(settingsPath);
  assert.equal(reread.talkEnabled, false);
  assert.equal(reread.privateMode, true);
  // No counterMode/counterTier keys exist on the type at all.
  assert.equal((reread as unknown as Record<string, unknown>).counterMode, undefined);
  assert.equal((reread as unknown as Record<string, unknown>).counterTier, undefined);
});

test("VoiceTranscriptStore.record honors retention and prunes text past retentionDays", async () => {
  const dir = await tmpDir("henry-voice-store-");
  const settingsPath = path.join(dir, "settings.json");
  updateVoiceSettings(settingsPath, { retentionDays: 1 });
  const store = new VoiceTranscriptStore(dir, settingsPath);
  try {
    const old = new Date(Date.now() - 5 * 86_400_000).toISOString();
    store.record({ surface: "talk", text: "old turn", at: old });
    const fresh = store.record({ surface: "talk", text: "fresh turn" });
    const remaining = store.list();
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].id, fresh.id);
  } finally {
    store.close();
  }
});

test("VoiceTranscriptStore.record writes nothing to disk while privateMode is on", async () => {
  const dir = await tmpDir("henry-voice-store-");
  const settingsPath = path.join(dir, "settings.json");
  updateVoiceSettings(settingsPath, { privateMode: true });
  const store = new VoiceTranscriptStore(dir, settingsPath);
  try {
    const record = store.record({ surface: "talk", text: "should not persist" });
    assert.equal(record.text, "should not persist");
    assert.equal(store.get(record.id), undefined);
    assert.equal(store.list().length, 0);
  } finally {
    store.close();
  }
});

test("VoiceTranscriptStore.saveAudio only writes while recordAudio is on", async () => {
  const dir = await tmpDir("henry-voice-store-");
  const settingsPath = path.join(dir, "settings.json");
  const store = new VoiceTranscriptStore(dir, settingsPath);
  try {
    const record = store.record({ surface: "telegram", text: "hi" });
    assert.equal(store.saveAudio(record.id, Buffer.from([1, 2, 3])), undefined);
    updateVoiceSettings(settingsPath, { recordAudio: true });
    const savedPath = store.saveAudio(record.id, Buffer.from([1, 2, 3]));
    assert.ok(savedPath);
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------ *
 * roman.ts sample conversions
 * ------------------------------------------------------------------ */

test("hasDevanagari detects Devanagari codepoints", () => {
  assert.equal(hasDevanagari("mujhe das bulb chahiye"), false);
  assert.equal(hasDevanagari("मुझे दस बल्ब चाहिए"), true);
});

test("toRomanHinglish converts common Hindi words and loanwords, leaves brands normal-spelled", () => {
  assert.equal(toRomanHinglish("mujhe das bulb chahiye"), "mujhe das bulb chahiye");
  assert.equal(toRomanHinglish("मुझे दस बल्ब चाहिए"), "mujhe das bulb chahiye");
  assert.equal(toRomanHinglish("हैवेल्स"), "Havells");
  assert.equal(toRomanHinglish("वी गार्ड"), "V-Guard");
});

/* ------------------------------------------------------------------ *
 * Launcher resolver: Henry path first, Kelly fallback, disabled when neither
 * ------------------------------------------------------------------ */

test("resolveVoicePaths prefers Henry's own assets over Kelly's fallback", () => {
  const henryRoot = "/fake/henry";
  const kellyRoot = "/fake/kelly";
  const henryWhisper = path.join(henryRoot, "data/voice/models", VOICE_MODEL_FILES.whisperModel);
  const kellyWhisper = path.join(kellyRoot, "data/voice/models", VOICE_MODEL_FILES.whisperModel);
  const resolved = resolveVoicePaths({
    henryRoot,
    kellyRoot,
    env: { HENRY_WHISPER_CPP_PATH: "/opt/homebrew/bin/whisper-cli" } as NodeJS.ProcessEnv,
    exists: (candidate) => candidate === henryWhisper || candidate === kellyWhisper,
    which: () => undefined,
  });
  assert.equal(resolved.whisperModelPath, henryWhisper);
});

test("resolveVoicePaths falls back to Kelly's checkout when Henry has nothing", () => {
  const henryRoot = "/fake/henry";
  const kellyRoot = "/fake/kelly";
  const kellyKokoroModel = path.join(kellyRoot, "data/voice/models", VOICE_MODEL_FILES.kokoroModel);
  const kellyKokoroVoices = path.join(kellyRoot, "data/voice/models", VOICE_MODEL_FILES.kokoroVoices);
  const kellyPython = path.join(kellyRoot, "data/voice/venv/bin/python");
  const resolved = resolveVoicePaths({
    henryRoot,
    kellyRoot,
    env: {} as NodeJS.ProcessEnv,
    exists: (candidate) => [kellyKokoroModel, kellyKokoroVoices, kellyPython].includes(candidate),
    which: () => undefined,
  });
  assert.equal(resolved.kokoroModelPath, kellyKokoroModel);
  assert.equal(resolved.kokoroVoicesPath, kellyKokoroVoices);
  assert.equal(resolved.python, kellyPython);
  assert.equal(resolved.ttsEnabled, true);
  assert.equal(resolved.sttEnabled, false);
  assert.ok(resolved.disabledReason?.includes("speech-to-text"));
});

test("resolveVoicePaths disables voice entirely when neither root has assets", () => {
  const resolved = resolveVoicePaths({
    henryRoot: "/fake/henry",
    kellyRoot: "/fake/kelly",
    env: {} as NodeJS.ProcessEnv,
    exists: () => false,
    which: () => undefined,
  });
  assert.equal(resolved.sttEnabled, false);
  assert.equal(resolved.ttsEnabled, false);
  assert.ok(resolved.disabledReason);
});

test("resolveVoicePaths defaults kellyRoot to Kelly's known checkout path", () => {
  const resolved = resolveVoicePaths({
    henryRoot: "/fake/henry",
    env: {} as NodeJS.ProcessEnv,
    exists: (candidate) => candidate.startsWith(DEFAULT_KELLY_ROOT),
    which: () => undefined,
  });
  assert.equal(resolved.kokoroModelPath, path.join(DEFAULT_KELLY_ROOT, "data/voice/models", VOICE_MODEL_FILES.kokoroModel));
});

/* ------------------------------------------------------------------ *
 * runVoiceCommand smoke test (real subprocess, no shell)
 * ------------------------------------------------------------------ */

test("runVoiceCommand never invokes a shell and captures exit code", async () => {
  const result = await runVoiceCommand(process.execPath, ["-e", "process.exit(0)"], {
    timeoutMs: 5000, maxStdoutBytes: 1024, maxStderrBytes: 1024,
  });
  assert.equal(result.exitCode, 0);
});
