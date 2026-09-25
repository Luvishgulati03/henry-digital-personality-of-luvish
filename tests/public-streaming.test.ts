import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { PUBLIC_ORIGIN, claudeStream, cookieFrom, publicHarness, sse, tunnel } from "./public-harness.ts";
import { CLIENT_LOG_EVENTS, PUBLIC_LINES, VAD_CDN_ORIGIN } from "../src/public/surface.ts";
import { readLogEntries } from "../src/public/log.ts";
import type { ProviderEvent } from "../src/types.ts";

/**
 * Streamed public replies end to end (real surface, fake CLI events), the public request log, and
 * the page trouble-report endpoint. Unit rules for the sentence guard live in public-stream.test.ts.
 */

const json = { "content-type": "application/json" };

async function chat(base: string, message: string, cookie = "", body: Record<string, unknown> = {}, ip = "203.0.113.7"): Promise<Response> {
  return fetch(`${base}/api/public/chat`, {
    method: "POST",
    headers: { ...tunnel({}, ip), ...json, origin: PUBLIC_ORIGIN, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ message, ...body }),
  });
}

const shown = (events: Array<{ event: string; data: Record<string, unknown> }>): string => {
  let text = "";
  for (const { event, data } of events) {
    if (event === "token") text += String(data.text ?? "");
    else if (event === "reset") text = "";
    else if (event === "replace") text = String(data.text ?? "");
  }
  return text;
};

test("streaming: sentences arrive as separate token events before done; done says the tokens were the whole reply", async () => {
  const h = await publicHarness();
  try {
    h.stream.current = () => ({ events: claudeStream(["Alex Example bu", "ilds products. ", "Mostly dash", "boards! Ask ", "me more."]) });
    const events = await sse(await chat(h.base, "What does Alex build?"));
    const tokens = events.filter((event) => event.event === "token").map((event) => event.data.text);
    assert.deepEqual(tokens, ["Alex Example builds products. ", "Mostly dashboards! ", "Ask me more."]);
    const done = events.find((event) => event.event === "done");
    assert.equal(done?.data.response, "Alex Example builds products. Mostly dashboards! Ask me more.");
    assert.equal(done?.data.streamed, true);
    assert.equal(shown(events), done?.data.response);
    assert.ok(tokens.every((_, index) => events.findIndex((event) => event.event === "token") + index < events.findIndex((event) => event.event === "done")));
    assert.ok(!events.some((event) => event.event === "token" && "replyId" in event.data), "a typed chat turn gets no speech ids");
  } finally { await h.close(); }
});

test("streaming: the guard trips mid-stream, nothing unsafe is sent, and the streamed text is replaced", async () => {
  const h = await publicHarness();
  try {
    h.stream.current = () => ({ events: claudeStream(["Happy to help. ", "The file lives at /Us", "ers/alex/.env on disk. ", "Anything else?"]) });
    const events = await sse(await chat(h.base, "where is your env"));
    const raw = JSON.stringify(events.filter((event) => event.event !== "replace" && event.event !== "done"));
    assert.ok(!raw.includes("/Users/"), "the unsafe sentence never left the server");
    assert.deepEqual(events.filter((event) => event.event === "token").map((event) => event.data.text), ["Happy to help. "]);
    const replace = events.find((event) => event.event === "replace");
    assert.match(String(replace?.data.text), /can't share that/);
    const done = events.find((event) => event.event === "done");
    assert.equal(done?.data.streamed, false);
    assert.equal(done?.data.response, replace?.data.text);
    assert.ok(!JSON.stringify(events).includes("/Users/"));
    const activity = await h.runtime.activity.list(50);
    assert.ok(activity.some((event) => event.kind === "public.refused" && event.metadata?.reason === "local path" && event.metadata?.midStream === true));
  } finally { await h.close(); }
});

test("streaming: a tool-call event mid-stream withdraws what was sent (reset) and the turn fails closed", async () => {
  const h = await publicHarness();
  try {
    const toolUse: ProviderEvent = { timestamp: "", stream: "stdout", text: "", parsed: { type: "stream_event", event: { type: "content_block_start", index: 1, content_block: { type: "tool_use", name: "Read" } } } };
    // The fake runner does not apply the runner's post-run rail, so it reports the violation itself.
    h.stream.current = () => ({ events: claudeStream(["Let me look that up. ", "Reading now. "], { extra: [toolUse] }), error: "public sandbox violation: claude attempted a tool call on a public turn" });
    const events = await sse(await chat(h.base, "read soul.md"));
    const names = events.map((event) => event.event);
    assert.ok(names.includes("token"), "sentences went out before the tool call");
    const resetAt = names.indexOf("reset");
    assert.ok(resetAt > names.lastIndexOf("token"), "the reset follows the last token");
    assert.deepEqual(events.at(-1), { event: "error", data: { error: PUBLIC_LINES.failed } });
    assert.equal(shown(events), "");
    assert.ok(!names.includes("done"));
  } finally { await h.close(); }
});

test("streaming: a failover attempt resets the first attempt's text; only the answering attempt stands", async () => {
  const h = await publicHarness();
  try {
    const first = claudeStream(["You've hit your usage limit. ", "Resets at 3pm. "]).slice(0, -1);
    const codex: ProviderEvent[] = [
      { timestamp: "", stream: "stdout", text: "", parsed: { type: "thread.started", thread_id: "t" } },
      { timestamp: "", stream: "stdout", text: "", parsed: { type: "item.completed", item: { type: "agent_message", text: "Alex Example builds products. Ask away." } } },
      { timestamp: "", stream: "stdout", text: "", parsed: { type: "result", result: "Alex Example builds products. Ask away.", is_error: false } },
    ];
    const opener = claudeStream(["Hello there. ", "One moment"]).slice(0, -1);
    h.stream.current = () => ({ events: [...opener, ...first, ...codex] });
    const events = await sse(await chat(h.base, "hi"));
    assert.ok(events.some((event) => event.event === "reset"), "the earlier attempt's sentences are withdrawn");
    assert.ok(!JSON.stringify(events).includes("usage limit"), "a limit notice is held, never streamed");
    assert.equal(shown(events), "Alex Example builds products. Ask away.");
    assert.equal(events.find((event) => event.event === "done")?.data.streamed, true);
  } finally { await h.close(); }
});

test("streaming voice: every sentence gets a speech id; follow-on sentences are free once, then rate-limited like any reply", async () => {
  const h = await publicHarness({ mode: { perClientPerMinute: 1, perClientPerHour: 100 } });
  try {
    h.stream.current = () => ({ events: claudeStream(["First sentence here. ", "Second one. ", "Third."]) });
    const page = await fetch(`${h.base}/public/talk`, { headers: tunnel() });
    const cookie = cookieFrom(page);
    const events = await sse(await chat(h.base, "tell me", cookie, { voice: true }));
    const ids = events.filter((event) => event.event === "token").map((event) => String(event.data.replyId));
    assert.equal(ids.length, 3);
    assert.equal(events.find((event) => event.event === "done")?.data.streamed, true);
    const speak = (replyId: string) => fetch(`${h.base}/api/public/voice/speak`, { method: "POST", headers: { ...tunnel(), ...json, origin: PUBLIC_ORIGIN, cookie }, body: JSON.stringify({ replyId }) });
    // The audio limiter allows 2/minute here (perClientPerMinute * 2): the first sentence pays one.
    for (const id of ids) assert.equal((await speak(id)).status, 200);
    assert.deepEqual(h.tts.slice(-3), ["First sentence here.", "Second one.", "Third."]);
    // Replaying a follow-on sentence is no longer free: one more paid request, then 429.
    assert.equal((await speak(ids[1])).status, 200);
    assert.equal((await speak(ids[2])).status, 429);
    // Another visitor cannot speak these ids.
    const stranger = await fetch(`${h.base}/api/public/voice/speak`, { method: "POST", headers: { ...tunnel({}, "198.51.100.9"), ...json, origin: PUBLIC_ORIGIN }, body: JSON.stringify({ replyId: ids[0] }) });
    assert.equal(stranger.status, 404);
  } finally { await h.close(); }
});

test("public log: one JSON line per request with timings, a hashed visitor, CF-Ray; never text, IPs, or cookies", async () => {
  const h = await publicHarness();
  try {
    h.stream.current = () => ({ events: claudeStream(["Alex Example builds products. ", "Nice."]) });
    const page = await fetch(`${h.base}/public/chat`, { headers: tunnel() });
    const cookie = cookieFrom(page);
    const visitorId = cookie.split("=")[1];
    await sse(await chat(h.base, "SECRET-QUESTION-TEXT reach me at someone@example.com", cookie));
    await fetch(`${h.base}/api/approvals?token=abc`, { headers: tunnel() });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const text = fs.readFileSync(h.log.file, "utf8");
    for (const forbidden of ["SECRET-QUESTION-TEXT", "someone@example.com", "203.0.113.7", visitorId, "Alex Example builds", "token=abc"]) {
      assert.ok(!text.includes(forbidden), `the log must not contain ${forbidden}`);
    }
    const entries = readLogEntries(h.log.file);
    const turn = entries.find((entry) => entry.route === "POST /api/public/chat");
    assert.ok(turn);
    assert.equal(turn.status, 200);
    assert.equal(turn.tunnelled, true);
    assert.equal(turn.ray, "8f00000000000000-LHR");
    assert.equal(turn.visitor, h.log.visitorHash(visitorId));
    assert.equal(turn.provider, "claude");
    assert.equal(turn.model, "claude-test-model");
    assert.equal(turn.firstTextMs, 5);
    assert.equal(typeof turn.firstSentMs, "number");
    assert.equal(typeof turn.totalMs, "number");
    assert.equal(turn.streamed, 2);
    assert.ok(Number(turn.bytes) > 0);
    const pageLine = entries.find((entry) => entry.path === "/public/chat");
    assert.equal(pageLine?.visitor, turn.visitor, "the same visitor correlates across requests");
    const denied = entries.find((entry) => entry.path === "/api/approvals");
    assert.equal(denied?.status, 401, "a denied tunnel request is logged too (path without its query)");
  } finally { await h.close(); }
});

test("public log: rate-limit and busy refusals are flagged; the journal gets a sample, not every one", async () => {
  const h = await publicHarness({ mode: { perVisitorPerMinute: 1, perClientPerMinute: 100 } });
  try {
    const page = await fetch(`${h.base}/public/chat`, { headers: tunnel() });
    const cookie = cookieFrom(page);
    await sse(await chat(h.base, "one", cookie));
    for (let index = 0; index < 4; index += 1) assert.equal((await chat(h.base, "again", cookie)).status, 429);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const limited = readLogEntries(h.log.file).filter((entry) => entry.rateLimited === true);
    assert.equal(limited.length, 4);
    const journal = (await h.runtime.activity.list(100)).filter((event) => event.kind === "public.refused" && event.metadata?.reason === "rate");
    assert.equal(journal.length, 1, "one sampled refusal per minute in the activity journal");
  } finally { await h.close(); }
});

test("client-log: fixed schema, allowlisted events, rate-limited, logged as data", async () => {
  const h = await publicHarness();
  try {
    const post = (body: unknown, ip = "203.0.113.50", origin = PUBLIC_ORIGIN) => fetch(`${h.base}/api/public/client-log`, {
      method: "POST", headers: { ...tunnel({}, ip), ...json, origin }, body: JSON.stringify(body),
    });
    assert.equal((await post({ event: "vad.cdn_failed", detail: "cdn: script did not load" })).status, 200);
    assert.equal((await post({ event: "vad.ready", detail: "local 900ms" })).status, 200);
    assert.equal((await post({ event: "not.an.event", detail: "x" })).status, 400);
    assert.equal((await post({ event: "vad.failed", detail: "x", extra: 1 })).status, 400);
    assert.equal((await post({ event: "vad.failed", detail: 42 })).status, 400);
    assert.equal((await post({ event: "vad.failed" }, "203.0.113.51", "https://evil.example")).status, 403);
    const long = "call me on +44 7700 900123 " + "x".repeat(400);
    assert.equal((await post({ event: "audio.error", detail: long })).status, 200);
    let limited = 0;
    for (let index = 0; index < 12; index += 1) if ((await post({ event: "asset.error", detail: "n" })).status === 429) limited += 1;
    assert.ok(limited > 0, "the endpoint is rate-limited per client");
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = readLogEntries(h.log.file).filter((entry) => entry.route === "POST /api/public/client-log" && entry.status === 200);
    const audio = lines.find((entry) => entry.event === "audio.error");
    assert.ok(audio && String(audio.detail).length <= 200);
    assert.ok(!String(audio.detail).includes("7700"), "contact-looking detail is masked");
    assert.ok(lines.some((entry) => entry.event === "vad.cdn_failed" && entry.detail === "cdn: script did not load"));
    const journal = (await h.runtime.activity.list(100)).filter((event) => event.kind === "public.client");
    assert.ok(journal.some((event) => event.metadata?.event === "vad.cdn_failed"));
    assert.ok(!journal.some((event) => event.metadata?.event === "vad.ready"), "a healthy load is not journal noise");
    assert.ok(CLIENT_LOG_EVENTS.includes("vad.slow"));
  } finally { await h.close(); }
});

test("public pages allow exactly the pinned CDN origin; /vendor/vad files are cached as immutable", async () => {
  const h = await publicHarness();
  try {
    const page = await fetch(`${h.base}/public/talk`, { headers: tunnel() });
    const csp = page.headers.get("content-security-policy") ?? "";
    const directive = (name: string) => csp.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name} `)) ?? "";
    assert.ok(directive("script-src").split(" ").includes(VAD_CDN_ORIGIN));
    assert.ok(directive("connect-src").split(" ").includes(VAD_CDN_ORIGIN));
    const origins = csp.match(/https:\/\/[^\s;]+/g) ?? [];
    assert.deepEqual([...new Set(origins)], [VAD_CDN_ORIGIN], "no other external origin, no wildcard");
    assert.ok(!/\*/.test(csp));
    for (const other of ["/public/chat", "/"]) {
      const otherCsp = (await fetch(`${h.base}${other}`, { headers: tunnel() })).headers.get("content-security-policy") ?? "";
      assert.ok(otherCsp.includes("connect-src 'self'") && !otherCsp.includes("https://"), `${other} loads nothing external`);
    }
    const html = await page.text();
    assert.match(html, /<link rel="preconnect" href="https:\/\/cdn\.jsdelivr\.net" crossorigin>/);
    assert.match(html, /@ricky0123\/vad-web@0\.0\.31\/dist\/bundle\.min\.js/);
    assert.match(html, /onnxruntime-web@1\.30\.0\/dist\//);
    assert.match(html, /integrity: 'sha384-[A-Za-z0-9+/=]{64}'/);
    const pkg = JSON.parse(fs.readFileSync(new URL("../node_modules/@ricky0123/vad-web/package.json", import.meta.url), "utf8"));
    const ort = JSON.parse(fs.readFileSync(new URL("../node_modules/onnxruntime-web/package.json", import.meta.url), "utf8"));
    assert.equal(pkg.version, "0.0.31", "the CDN pin must match the installed vad-web (update both together)");
    assert.equal(ort.version, "1.30.0", "the CDN pin must match the installed onnxruntime-web (update both together)");
    const crypto = await import("node:crypto");
    const bundle = fs.readFileSync(new URL("../node_modules/@ricky0123/vad-web/dist/bundle.min.js", import.meta.url));
    assert.ok(html.includes(`sha384-${crypto.createHash("sha384").update(bundle).digest("base64")}`), "the SRI hash is the installed bundle's");
    for (const [headers, label] of [[tunnel(), "tunnel"], [{}, "local"]] as const) {
      const asset = await fetch(`${h.base}/vendor/vad/silero_vad_v5.onnx`, { headers });
      assert.equal(asset.status, 200, label);
      assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable", label);
      await asset.arrayBuffer();
    }
  } finally { await h.close(); }
});
