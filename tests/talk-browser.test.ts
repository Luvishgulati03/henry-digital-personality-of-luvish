import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import http from "node:http";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import type { DashboardVoice } from "../src/dashboard/server.ts";

/**
 * Henry Talk in a real (headless) Chromium against a fake backend that serves the real
 * talk.html. The Silero bundle 404s here on purpose, so the page runs its energy VAD and the
 * test drives speech with `HenryTalk.testing.levelOverride` (the fake microphone is a tone).
 */

function tone(samples: number): Buffer {
  const wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write("data", 36); wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) wav.writeInt16LE(Math.round(Math.sin(i * 2 * Math.PI * 440 / 16000) * 8000), 44 + i * 2);
  return wav;
}
function frame(body: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(body.length, 0);
  return Buffer.concat([len, body]);
}
async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
  return Buffer.concat(parts);
}
function sse(res: http.ServerResponse, ev: string, data: unknown): void {
  res.write(`event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`);
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Backend {
  base: string;
  uploads: Buffer[];
  chatCalls: Array<Record<string, unknown>>;
  speakCalls: Array<Record<string, unknown>>;
  created: string[];
  conversations: Set<string>;
  counts: { greeting: number; filler: number; sessionStart: number; sessionEnd: number };
  status: Record<string, unknown>;
  close(): Promise<void>;
}

async function backend(): Promise<Backend> {
  const html = await fs.readFile(new URL("../src/dashboard/talk.html", import.meta.url), "utf8");
  const b: Backend = {
    base: "", close: async () => undefined,
    uploads: [], chatCalls: [], speakCalls: [], created: [], conversations: new Set(),
    counts: { greeting: 0, filler: 0, sessionStart: 0, sessionEnd: 0 },
    status: { available: true, sttEnabled: true, ttsEnabled: true, talkEnabled: true, privateMode: false, allowWrites: false },
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://x");
    const route = url.pathname;
    if (route === "/talk") { res.setHeader("content-type", "text/html"); res.end(html); return; }
    if (route.startsWith("/vendor/vad/")) { res.writeHead(404).end(); return; }
    if (route === "/api/voice/status") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(b.status)); return; }
    if (route === "/api/voice/greeting") { b.counts.greeting++; res.setHeader("content-type", "audio/wav"); res.end(tone(800)); return; }
    if (route === "/api/voice/reprompt") { res.setHeader("content-type", "audio/wav"); res.end(tone(400)); return; }
    if (route === "/api/voice/filler") { b.counts.filler++; res.setHeader("content-type", "audio/wav"); res.end(tone(400)); return; }
    if (route === "/api/voice/talk/session") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (body.event === "start") b.counts.sessionStart++; else b.counts.sessionEnd++;
      res.setHeader("content-type", "application/json"); res.end("{\"ok\":true}"); return;
    }
    if (route === "/api/conversations" && req.method === "POST") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const id = `conv_${b.created.length + 1}`;
      b.created.push(body.title); b.conversations.add(id);
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ conversation: { id, title: body.title } })); return;
    }
    if (route === "/api/chat/history") {
      const id = url.searchParams.get("conversationId") || "";
      res.writeHead(b.conversations.has(id) ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify(b.conversations.has(id) ? { conversationId: id, messages: [] } : { error: "conversation not found" }));
      return;
    }
    if (route === "/api/voice/transcribe") {
      b.uploads.push(await readBody(req));
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ text: "what's the latest on Engram", transcriptId: "t-" + b.uploads.length }));
      return;
    }
    if (route === "/api/chat/send") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      b.chatCalls.push(body);
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      // A lookup: gathering first, a pause long enough for the first filler, then two spoken lines.
      sse(res, "gathering", { reason: "request" });
      await sleep(400);
      sse(res, "spoken", { text: "Looking at Engram now." });
      sse(res, "spoken", { text: "Two updates since Monday." });
      sse(res, "done", { response: "Two updates.", conversationId: body.conversationId });
      res.end();
      return;
    }
    if (route === "/api/voice/speak") {
      b.speakCalls.push(JSON.parse((await readBody(req)).toString("utf8") || "{}"));
      res.writeHead(200, { "content-type": "application/x-henry-wav-seq" });
      res.write(frame(tone(1600)));
      res.end();
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  b.base = `http://127.0.0.1:${address.port}`;
  b.close = () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  return b;
}

/** Pages share one context (one browser profile), so localStorage persists across sessions like a real tab. */
async function openTalk(context: BrowserContext, url: string, errors: string[]): Promise<Page> {
  const page = await context.newPage();
  await page.route("https://**/*", (route) => route.abort());
  page.on("pageerror", (error) => errors.push(`${page.url()}: ${error.message}`));
  await page.goto(url);
  await page.waitForFunction(() => (window as unknown as { HenryTalk?: { testing: { voiceStatus: unknown } } }).HenryTalk?.testing.voiceStatus != null);
  return page;
}

const stateText = (page: Page) => page.evaluate(() => document.querySelector("#state")?.textContent);
const waitState = (page: Page, text: string) => page.waitForFunction((t) => document.querySelector("#state")?.textContent === t, text, { timeout: 15000 });

/** One fake-VAD utterance: loud long enough to start capture, then silence to end it. */
async function speakOnce(page: Page): Promise<void> {
  await page.evaluate(() => { const t = (window as any).HenryTalk.testing; t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9; });
  await page.waitForTimeout(300);
  await page.evaluate(() => { const t = (window as any).HenryTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
}

async function launch(): Promise<Browser | undefined> {
  try {
    return await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  } catch {
    return undefined;
  }
}

test("talk page: press, greeting, a fake-VAD turn with filler + spoken queue, re-arm, one remembered Voice conversation", { timeout: 120000 }, async (t) => {
  const be = await backend();
  const browser = await launch();
  if (!browser) { await be.close(); t.skip("Playwright Chromium is not installed"); return; }
  const errors: string[] = [];
  const context = await browser.newContext();
  try {
    // Rest state; captions are on by default for Henry and hidden with ?captions=0.
    const page = await openTalk(context, `${be.base}/talk`, errors);
    assert.equal(await stateText(page), "Tap to talk");
    assert.equal(await page.locator("#captions").isHidden(), false, "captions default on");
    assert.equal(await page.locator("#privateBadge").isHidden(), true, "no private badge when private mode is off");
    assert.equal(await page.locator(".nav").isVisible(), true, "standalone page links back to Henry");
    assert.equal(await page.evaluate(() => typeof (window as any).HenryOrb?.mount), "function");
    const hidden = await openTalk(context, `${be.base}/talk?captions=0`, errors);
    assert.equal(await hidden.locator("#captions").isHidden(), true, "?captions=0 hides captions");
    await hidden.close();

    // Press: greeting, then Listening. First use creates the "Voice" conversation and remembers it.
    await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await waitState(page, "Listening");
    assert.equal(be.counts.greeting, 1);
    assert.equal(be.counts.sessionStart, 1);
    assert.equal(await page.evaluate(() => (window as any).HenryTalk.testing.vadMode), "energy", "bundle 404 falls back to the energy VAD");
    await page.waitForFunction(() => (window as any).HenryTalk.testing.conversationId === "conv_1");
    assert.deepEqual(be.created, ["Voice"]);
    assert.equal(await page.evaluate(() => localStorage.getItem("henry.voice.conversationId")), "conv_1");

    // One turn: one 16 kHz mono WAV upload, a voice chat turn, a filler during the gather pause,
    // then both spoken lines in order, then back to Listening with no second press.
    await page.evaluate(() => { const t = (window as any).HenryTalk.testing; t.fillerMs = 50; t.secondFillerMs = 60000; });
    await speakOnce(page);
    await waitState(page, "Speaking");
    await waitState(page, "Listening");
    assert.equal(be.uploads.length, 1);
    assert.equal(be.uploads[0].subarray(0, 4).toString(), "RIFF");
    assert.equal(be.uploads[0].readUInt16LE(22), 1, "mono");
    assert.equal(be.uploads[0].readUInt32LE(24), 16000, "16 kHz");
    assert.equal(be.chatCalls.length, 1);
    assert.equal(be.chatCalls[0].voice, true);
    assert.equal(be.chatCalls[0].prompt, "what's the latest on Engram");
    assert.equal(be.chatCalls[0].transcriptId, "t-1");
    assert.equal(be.chatCalls[0].conversationId, "conv_1");
    assert.equal(be.counts.filler, 1, "the gather pause earned exactly one filler");
    assert.deepEqual(be.speakCalls.map((call) => call.text), ["Looking at Engram now.", "Two updates since Monday."], "spoken lines play in order");
    assert.ok(be.speakCalls.every((call) => call.chunk === true));
    assert.equal(await page.locator("#heard").textContent(), "what's the latest on Engram");
    assert.equal(await page.locator("#reply").textContent(), "Two updates since Monday.");
    assert.equal(await page.locator("#talk").getAttribute("aria-pressed"), "true");

    // Re-arm: a second turn without pressing again.
    await speakOnce(page);
    await waitState(page, "Speaking");
    await waitState(page, "Listening");
    assert.equal(be.uploads.length, 2);
    assert.equal(be.chatCalls[1].conversationId, "conv_1");

    // End the session; a new session (a fresh page, same browser profile) reuses the remembered conversation.
    await page.keyboard.press("Escape");
    await waitState(page, "Tap to talk");
    await page.close();
    const again = await openTalk(context, `${be.base}/talk`, errors);
    await again.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await waitState(again, "Listening");
    await again.waitForFunction(() => (window as any).HenryTalk.testing.conversationId === "conv_1");
    assert.deepEqual(be.created, ["Voice"], "no second conversation for the second session");
    await speakOnce(again);
    await waitState(again, "Speaking");
    await waitState(again, "Listening");
    assert.equal(be.chatCalls.at(-1)?.conversationId, "conv_1", "Henry remembers earlier voice sessions");

    // The remembered conversation was deleted server-side: the next session recreates "Voice".
    be.conversations.delete("conv_1");
    await again.getByRole("button", { name: "End session" }).click();
    await waitState(again, "Tap to talk");
    await again.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await waitState(again, "Listening");
    await again.waitForFunction(() => (window as any).HenryTalk.testing.conversationId === "conv_2");
    assert.deepEqual(be.created, ["Voice", "Voice"]);
    assert.equal(await again.evaluate(() => localStorage.getItem("henry.voice.conversationId")), "conv_2");
    await again.close();
    assert.ok(be.counts.sessionEnd >= 2, "session end is reported");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await be.close();
  }
});

test("talk page: embed joins the chat's conversation; private mode badge; voice-off state", { timeout: 60000 }, async (t) => {
  const be = await backend();
  const browser = await launch();
  if (!browser) { await be.close(); t.skip("Playwright Chromium is not installed"); return; }
  const errors: string[] = [];
  const context = await browser.newContext();
  try {
    be.status = { ...be.status, privateMode: true, allowWrites: true };
    const page = await openTalk(context, `${be.base}/talk?embed=1&captions=1&conversationId=conv_chat`, errors);
    assert.equal(await page.locator("#privateBadge").isVisible(), true, "private-mode badge shows");
    assert.equal(await page.locator("#writesBadge").isVisible(), true, "allow-writes badge shows");
    assert.equal(await page.locator(".nav").isVisible(), false, "embedded: no page nav");
    await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await waitState(page, "Listening");
    assert.equal(await page.evaluate(() => (window as any).HenryTalk.testing.conversationId), "conv_chat");
    await speakOnce(page);
    await waitState(page, "Speaking");
    await waitState(page, "Listening");
    assert.equal(be.chatCalls.at(-1)?.conversationId, "conv_chat");
    assert.deepEqual(be.created, [], "embed never creates a conversation");
    assert.equal(await page.evaluate(() => localStorage.getItem("henry.voice.conversationId")), null, "embed does not overwrite the remembered Voice thread");
    await page.close();

    be.status = { available: false, sttEnabled: false, ttsEnabled: false, talkEnabled: true, privateMode: false, allowWrites: false, reason: "Speech-to-text is not set up." };
    const off = await openTalk(context, `${be.base}/talk`, errors);
    await waitState(off, "Voice is off");
    assert.equal(await off.locator("#talk").isDisabled(), true);
    assert.equal(await off.locator("#note").textContent(), "Speech-to-text is not set up.");
    await off.close();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await be.close();
  }
});

test("real dashboard: chat Talk overlay opens /talk embedded, closes to about:blank; voice card toggles private mode", { timeout: 90000 }, async (t) => {
  const browser = await launch();
  if (!browser) { t.skip("Playwright Chromium is not installed"); return; }
  const { HenryRuntime } = await import("../src/runtime.ts");
  const { startDashboard } = await import("../src/dashboard/server.ts");
  const os = await import("node:os");
  const path = await import("node:path");
  const nodeFs = await import("node:fs");
  const root = nodeFs.mkdtempSync(path.join(os.tmpdir(), "henry-talk-overlay-"));
  nodeFs.cpSync(path.join(process.cwd(), "workflows"), path.join(root, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(root);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  const voice = {
    sttEnabled: () => true, ttsEnabled: () => true,
    transcribe: async () => ({ text: "hello" }), synthesize: async () => tone(160),
  } as unknown as DashboardVoice;
  const server = startDashboard(runtime, { voice, warmVoicePrompts: false });
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const errors: string[] = [];
  const context = await browser.newContext();
  try {
    const conversation = await (await fetch(`${base}/api/conversations`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Planning" }) })).json() as { conversation: { id: string } };
    const chat = await context.newPage();
    await chat.route("https://**/*", (route) => route.abort());
    chat.on("pageerror", (error) => errors.push(error.message));
    await chat.goto(`${base}/chat`);
    await chat.waitForFunction(() => document.querySelector(".conv.active") !== null, undefined, { timeout: 15000 });
    await chat.locator("#openTalk").click();
    assert.equal(await chat.locator("#talkModal").evaluate((d: HTMLDialogElement) => d.open), true);
    const src = await chat.locator("#talkFrame").getAttribute("src");
    assert.equal(src, `/talk?embed=1&captions=1&conversationId=${conversation.conversation.id}`);
    const frame = chat.frameLocator("#talkFrame");
    await frame.locator("#talk").waitFor();
    assert.equal(await frame.locator(".nav").isVisible(), false, "embedded talk hides its own nav");
    await chat.locator("#talkClose").click();
    assert.equal(await chat.locator("#talkModal").evaluate((d: HTMLDialogElement) => d.open), false);
    assert.equal(await chat.locator("#talkFrame").getAttribute("src"), "about:blank");

    // Escape inside the frame asks the chat page to close the overlay.
    await chat.locator("#openTalk").click();
    await frame.locator("#talk").waitFor();
    await frame.locator("#talk").focus();
    await chat.keyboard.press("Escape");
    await chat.waitForFunction(() => !(document.getElementById("talkModal") as HTMLDialogElement).open, undefined, { timeout: 5000 });
    assert.equal(await chat.locator("#talkFrame").getAttribute("src"), "about:blank");

    const dash = await context.newPage();
    await dash.route("https://**/*", (route) => route.abort());
    dash.on("pageerror", (error) => errors.push(error.message));
    await dash.goto(`${base}/`);
    await dash.waitForFunction(() => !(document.getElementById("v-private") as HTMLInputElement).disabled, undefined, { timeout: 15000 });
    assert.equal(await dash.locator('a.link[href="/talk"]').first().isVisible(), true, "rail has a Talk link");
    await dash.locator("#v-private").check();
    await dash.waitForFunction(() => document.getElementById("voice-msg")?.textContent === "saved", undefined, { timeout: 5000 });
    const status = await (await fetch(`${base}/api/voice/status`)).json() as { privateMode: boolean };
    assert.equal(status.privateMode, true, "the card's toggle reached the server");
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
  }
});
