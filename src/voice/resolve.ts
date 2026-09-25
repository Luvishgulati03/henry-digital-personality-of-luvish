import fs from "node:fs";
import path from "node:path";

/**
 * LOCAL VOICE ASSET RESOLUTION — no downloads, ever.
 *
 * `henry start` needs a whisper.cpp model, a Kokoro ONNX model + voices file, a Python
 * interpreter with the Kokoro worker's dependencies installed, and a whisper-cli executable.
 * Henry never fetches any of these; it only looks in two places, in order:
 *
 *   1. Henry's own `data/voice/models/<file>` (or `data/voice/venv/bin/python`) — the
 *      owner installed assets for Henry directly.
 *   2. Kelly's checkout, read-only, at the same relative path — so a Mac that already set
 *      up Kelly's voice stack does not need a second multi-hundred-megabyte download just
 *      to give Henry a voice too.
 *
 * If NEITHER is present for a given asset, that asset resolves to `undefined` and the
 * caller (the launcher) disables the corresponding half of voice (STT or TTS) with a plain
 * message; the dashboard still starts. Nothing here assumes Kelly's checkout exists.
 */

export const VOICE_MODEL_FILES = Object.freeze({
  whisperModel: "ggml-small-q5_1.bin",
  kokoroModel: "kokoro-v1.0.int8.onnx",
  kokoroVoices: "voices-v1.0.bin",
});

/** Kelly's checkout on this machine, read-only, as a fallback asset source only. */
export const DEFAULT_KELLY_ROOT = "/Users/luvishgulati/Downloads/kelly";

export interface VoiceResolveOptions {
  /** Henry's own repository root (where `data/voice/...` would live). */
  henryRoot: string;
  /** Kelly's checkout root, read-only fallback; pass undefined to disable the fallback. */
  kellyRoot?: string;
  env?: NodeJS.ProcessEnv;
  /** Injectable for tests; defaults to `fs.existsSync`. */
  exists?: (candidate: string) => boolean;
  /** Injectable PATH lookup for whisper-cli; defaults to scanning `PATH` and `/opt/homebrew/bin`. */
  which?: (executable: string) => string | undefined;
}

export interface ResolvedVoicePaths {
  whisperCppPath?: string;
  whisperModelPath?: string;
  kokoroModelPath?: string;
  kokoroVoicesPath?: string;
  python?: string;
  sttEnabled: boolean;
  ttsEnabled: boolean;
  /** Set when at least one of STT/TTS could not be fully resolved; human-readable, no secrets. */
  disabledReason?: string;
}

function resolveAsset(filename: string, henryRoot: string, kellyRoot: string | undefined, exists: (candidate: string) => boolean): string | undefined {
  const henryPath = path.join(henryRoot, "data/voice/models", filename);
  if (exists(henryPath)) return henryPath;
  if (kellyRoot) {
    const kellyPath = path.join(kellyRoot, "data/voice/models", filename);
    if (exists(kellyPath)) return kellyPath;
  }
  return undefined;
}

function resolvePython(henryRoot: string, kellyRoot: string | undefined, exists: (candidate: string) => boolean): string | undefined {
  const henryPython = path.join(henryRoot, "data/voice/venv/bin/python");
  if (exists(henryPython)) return henryPython;
  if (kellyRoot) {
    const kellyPython = path.join(kellyRoot, "data/voice/venv/bin/python");
    if (exists(kellyPython)) return kellyPython;
  }
  return undefined;
}

function defaultWhich(executable: string): string | undefined {
  const directories = [...(process.env.PATH || "").split(path.delimiter), "/opt/homebrew/bin"];
  for (const directory of directories) {
    if (!directory) continue;
    const candidate = path.join(directory, executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* keep scanning */ }
  }
  return undefined;
}

/**
 * Resolves every local voice asset Henry needs, Henry-first then Kelly-fallback, and reports
 * whether STT/TTS end up usable. Never throws and never touches the network; a missing asset
 * is simply absent from the result.
 */
export function resolveVoicePaths(options: VoiceResolveOptions): ResolvedVoicePaths {
  const env = options.env ?? process.env;
  const exists = options.exists ?? ((candidate: string) => fs.existsSync(candidate));
  const which = options.which ?? defaultWhich;
  const kellyRoot = options.kellyRoot === undefined ? DEFAULT_KELLY_ROOT : options.kellyRoot;

  const whisperCppPath = env.HENRY_WHISPER_CPP_PATH || which("whisper-cli");
  const whisperModelPath = env.HENRY_WHISPER_MODEL_PATH
    || resolveAsset(VOICE_MODEL_FILES.whisperModel, options.henryRoot, kellyRoot, exists);
  const kokoroModelPath = env.HENRY_KOKORO_MODEL_PATH
    || resolveAsset(VOICE_MODEL_FILES.kokoroModel, options.henryRoot, kellyRoot, exists);
  const kokoroVoicesPath = env.HENRY_KOKORO_VOICES_PATH
    || resolveAsset(VOICE_MODEL_FILES.kokoroVoices, options.henryRoot, kellyRoot, exists);
  const python = env.HENRY_VOICE_PYTHON || resolvePython(options.henryRoot, kellyRoot, exists);

  const sttEnabled = Boolean(whisperCppPath && whisperModelPath);
  const ttsEnabled = Boolean(kokoroModelPath && kokoroVoicesPath && python);

  const missing: string[] = [];
  if (!sttEnabled) missing.push("speech-to-text (whisper-cli + a whisper model)");
  if (!ttsEnabled) missing.push("text-to-speech (Kokoro model + voices + Python)");
  const disabledReason = missing.length
    ? `Voice is disabled: missing local assets for ${missing.join(" and ")}. Install them under data/voice/, or share Kelly's at ${kellyRoot}, and run henry start again.`
    : undefined;

  return {
    ...(whisperCppPath ? { whisperCppPath } : {}),
    ...(whisperModelPath ? { whisperModelPath } : {}),
    ...(kokoroModelPath ? { kokoroModelPath } : {}),
    ...(kokoroVoicesPath ? { kokoroVoicesPath } : {}),
    ...(python ? { python } : {}),
    sttEnabled,
    ttsEnabled,
    ...(disabledReason ? { disabledReason } : {}),
  };
}
