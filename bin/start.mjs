import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs/promises";
import net from "node:net";
import dotenv from "dotenv";
import crypto from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const launcher = path.join(root, "bin/henry.mjs");
export const shellQuote = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
// Kelly's own Kokoro worker defaults to 8765; Henry uses a different port so both voice
// stacks can run on one Mac at the same time.
export const DEFAULT_KOKORO_URL = "http://127.0.0.1:8766";

export function terminalCommand(node, entry) {
  return [node, entry, "start", "--foreground"].map(shellQuote).join(" ");
}

export async function assertFree(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error(`Port ${port} is already in use. Stop the existing service before running henry start.`)));
    probe.listen(port, "127.0.0.1", () => probe.close(resolve));
  });
}

export async function waitReady(url, options = {}) {
  const { token, timeoutMs = 60000, fetcher = fetch, alive = () => true } = options;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!alive()) throw new Error("A Henry voice service exited during startup. See its error above.");
    try {
      const response = await fetcher(url, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(1500), redirect: "error",
      });
      await response.body?.cancel();
      if (response.ok) return;
      if (response.status === 401 || response.status === 403) throw new Error("Worker authentication failed; check Henry's local token configuration.");
    } catch (error) {
      if (error.message.startsWith("Worker authentication")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Henry startup timed out. Check the service output and local voice configuration.");
}

export async function supervise(commands, ready, options = {}) {
  const children = [];
  const launch = options.spawnProcess || spawn;
  let stopping = false;
  let finish;
  const ended = new Promise((resolve) => { finish = resolve; });
  const signal = (child, sig) => {
    if (!child.pid) return;
    try {
      if (process.platform !== "win32") process.kill(-child.pid, sig);
      else child.kill(sig);
    } catch { /* Already stopped. Never target unrelated processes. */ }
  };
  const stop = async (failed = false) => {
    if (stopping) return;
    stopping = true;
    for (const child of children) signal(child, "SIGTERM");
    // Include grandchildren such as the Python speech worker in shutdown.
    await new Promise((resolve) => setTimeout(resolve, options.graceMs ?? 1500));
    for (const child of children) signal(child, "SIGKILL");
    if (failed) process.exitCode = 1;
    finish();
  };
  const onSignal = () => { void stop(); };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  process.once("SIGHUP", onSignal);
  try {
    for (const command of commands) {
      const child = launch(command.file, command.args, {
        cwd: root, env: options.env || process.env, shell: false,
        detached: process.platform !== "win32", stdio: ["ignore", "inherit", "inherit"],
      });
      children.push(child);
      child.once("error", (error) => { console.error(`Henry service could not start: ${error.message}`); void stop(true); });
      child.once("exit", (code) => {
        if (!stopping) { console.error(`Henry service exited (${code ?? "signal"}); stopping the other service.`); void stop(true); }
      });
    }
    await ready(() => !stopping);
    await ended;
  } catch (error) {
    await stop(true);
    throw error;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    process.removeListener("SIGHUP", onSignal);
  }
}

export async function startHenry(args) {
  if (args.includes("--help")) {
    console.log("henry start: dashboard + local voice in a new macOS Terminal window.\nhenry start --foreground: run both here; Ctrl+C stops both.\nUses Henry's repository .env. No downloads. No public link is ever opened.\nLocal voice models and a Python interpreter are shared read-only from Kelly's checkout when Henry has none of its own; if neither has them, voice starts disabled and the dashboard still comes up.");
    return;
  }
  const knownFlags = args.filter((arg) => arg !== "--foreground");
  if (knownFlags.length) throw new Error("Usage: henry start [--foreground]");
  if (process.platform === "darwin" && !args.includes("--foreground")) {
    const script = 'on run argv\ntell application "Terminal"\nactivate\ndo script (item 1 of argv)\nend tell\nend run';
    await new Promise((resolve, reject) => {
      const child = spawn("/usr/bin/osascript", ["-e", script, terminalCommand(process.execPath, launcher)], { shell: false, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error("Could not open Terminal. Run henry start --foreground instead.")));
    });
    console.log("Opened Henry's service window. It will print the dashboard and voice URLs when ready.");
    return;
  }
  dotenv.config({ path: path.join(root, ".env"), quiet: true });

  const { resolveVoicePaths } = await import("../src/voice/resolve.ts");
  const resolved = resolveVoicePaths({ henryRoot: root });
  for (const [key, value] of [
    ["HENRY_WHISPER_CPP_PATH", resolved.whisperCppPath],
    ["HENRY_WHISPER_MODEL_PATH", resolved.whisperModelPath],
    ["HENRY_KOKORO_MODEL_PATH", resolved.kokoroModelPath],
    ["HENRY_KOKORO_VOICES_PATH", resolved.kokoroVoicesPath],
    ["HENRY_VOICE_PYTHON", resolved.python],
  ]) {
    if (!process.env[key] && value) process.env[key] = value;
  }
  process.env.HENRY_KOKORO_URL ||= DEFAULT_KOKORO_URL;
  process.env.HENRY_KOKORO_TOKEN ||= crypto.randomBytes(32).toString("hex");
  process.env.HENRY_TTS_ENGINE ||= "kokoro";

  const voiceReady = resolved.sttEnabled && resolved.ttsEnabled;
  if (!voiceReady) console.log(resolved.disabledReason || "Voice is disabled: local assets were not found.");

  const { loadConfig } = await import("../src/config.ts");
  // Avoid reading another project's .env when launched from an arbitrary directory.
  process.chdir(root);
  const config = loadConfig();

  let voiceUrl;
  try { voiceUrl = new URL(process.env.HENRY_KOKORO_URL); }
  catch { throw new Error("Set HENRY_KOKORO_URL to a loopback HTTP origin, for example http://127.0.0.1:8766."); }
  if (voiceUrl.protocol !== "http:" || voiceUrl.hostname !== "127.0.0.1" || voiceUrl.username || voiceUrl.password || voiceUrl.pathname !== "/" || voiceUrl.search || voiceUrl.hash) {
    throw new Error("For henry start, set HENRY_KOKORO_URL to http://127.0.0.1:<port>.");
  }
  const voicePort = Number(voiceUrl.port || 80);
  if (voicePort === config.port) throw new Error("Dashboard and voice worker need different ports.");

  await assertFree(config.port);
  const dashboard = `http://127.0.0.1:${config.port}`;

  if (!voiceReady) {
    console.log("Starting Henry dashboard only (voice disabled). Ctrl+C in this window stops it.");
    await supervise([
      { file: process.execPath, args: [launcher, "dashboard"] },
    ], async (alive) => {
      await waitReady(`${dashboard}/api/health`, { alive });
      if (!alive()) return;
      console.log(`Henry is ready.\nDashboard: ${dashboard}\nTalk: ${dashboard}/talk (voice disabled)\nPress Ctrl+C to stop.`);
    }, { env: process.env });
    return;
  }

  await assertFree(voicePort);
  const token = process.env.HENRY_KOKORO_TOKEN;
  const script = path.join(root, "scripts/voice/kokoro_server.py");
  console.log("Starting Henry dashboard and local speech worker. Ctrl+C in this window stops both.");
  await supervise([
    {
      file: resolved.python,
      args: [script, "--model", resolved.kokoroModelPath, "--voices", resolved.kokoroVoicesPath, "--port", String(voicePort)],
    },
    { file: process.execPath, args: [launcher, "dashboard"] },
  ], async (alive) => {
    await Promise.all([
      waitReady(new URL("/health", voiceUrl), { token, alive }),
      waitReady(`${dashboard}/api/health`, { alive }),
    ]);
    if (!alive()) return;
    console.log(`Henry is ready.\nDashboard: ${dashboard}\nTalk: ${dashboard}/talk\nLocal only. Press Ctrl+C to stop both services.`);
  }, {
    // The Kokoro worker reads its bearer token from KELLY_KOKORO_TOKEN (scripts/voice/kokoro_server.py
    // is shared verbatim with Kelly); wire Henry's own token through under that name.
    env: { ...process.env, KELLY_KOKORO_TOKEN: token },
  });
}
