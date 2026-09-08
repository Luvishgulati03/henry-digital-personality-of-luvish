import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";

test("dashboard exposes local health and status APIs", async () => {
  const runtime = await HenryRuntime.create();
  runtime.config.port = 0;
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const health = await (await fetch(`${base}/api/health`)).json() as { ok: boolean };
  const status = await (await fetch(`${base}/api/status`)).json() as { name: string; user: string };
  const tracesResponse = await fetch(`${base}/api/engram/traces?limit=999`);
  const traces = await tracesResponse.json() as { available: boolean; traces?: unknown[] };
  const observatory = await (await fetch(`${base}/memory`)).text();
  assert.equal(health.ok, true);
  assert.equal(status.name, "Henry");
  assert.equal(status.user, "Luvish");
  assert.equal(tracesResponse.status, 200);
  assert.equal(traces.available, true);
  assert.match(observatory, /context traces/);
  assert.match(observatory, /<details class='hmn-trace-row'>/);
  const traceRendererStart = observatory.indexOf("function renderRecallTraces");
  const traceRendererEnd = observatory.indexOf("function refreshRecallTraces");
  assert.ok(traceRendererStart >= 0 && traceRendererEnd > traceRendererStart);
  const traceRenderer = observatory.slice(traceRendererStart, traceRendererEnd);
  assert.match(traceRenderer, /memory\.score/);
  assert.match(traceRenderer, /memory\.why/);
  assert.match(traceRenderer, /memory\.source/);
  assert.match(traceRenderer, /memory\.outcome/);
  assert.doesNotMatch(traceRenderer, /memory\.content|trace\.query/);
  const crossOrigin = await fetch(`${base}/api/ask`, { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: JSON.stringify({ prompt: "hello" }) });
  assert.equal(crossOrigin.status, 403);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  runtime.close();
});

test("web chat: page serves, SSE send streams tokens, transcript persists, clear resets", async () => {
  // Isolated root so the test never touches the real data/chats transcript.
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-chat-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(tempRoot, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";

  // The chat rides agent.run — stub it to stream two chunks then return the final text.
  (runtime.agent as unknown as { run: unknown }).run = async (_prompt: string, options?: { onEvent?: (event: { timestamp: string; stream: string; text: string; parsed?: Record<string, unknown> }) => void }) => {
    options?.onEvent?.({ timestamp: "", stream: "stdout", text: "", parsed: { text: "Hello " } });
    options?.onEvent?.({ timestamp: "", stream: "stdout", text: "", parsed: { text: "Luvish!" } });
    return { runId: "run-1", provider: "claude", response: "Hello Luvish!", exitCode: 0, durationMs: 12, events: [] };
  };

  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/chat`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Message Henry/);

  const send = await fetch(`${base}/api/chat/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt: "hi" }),
  });
  assert.equal(send.status, 200);
  assert.match(send.headers.get("content-type") || "", /text\/event-stream/);
  const stream = await send.text();
  assert.match(stream, /event: token/);
  assert.match(stream, /Hello /);
  assert.match(stream, /event: done/);
  assert.match(stream, /Hello Luvish!/);

  const history = await (await fetch(`${base}/api/chat/history`)).json() as { messages: Array<{ role: string; text: string }> };
  assert.equal(history.messages.length, 2, "user + henry messages must persist");
  assert.equal(history.messages[0].role, "user");
  assert.equal(history.messages[1].text, "Hello Luvish!");

  const clear = await fetch(`${base}/api/chat/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(clear.status, 200);
  const cleared = await (await fetch(`${base}/api/chat/history`)).json() as { messages: unknown[] };
  assert.equal(cleared.messages.length, 0);

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  runtime.close();
});

test("logs page serves and /api/logs returns the activity journal newest-first", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-logs-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(tempRoot, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  await runtime.activity.record("memory.saved", "first event", { probe: 1 });
  await runtime.activity.record("run.failed", "second event", { error: "boom" });

  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const page = await fetch(`${base}/logs`);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(pageText, /Henry \/ event log/);
  assert.match(pageText, /data-cat="telegram"/);

  const logs = await (await fetch(`${base}/api/logs?limit=50`)).json() as { events: Array<{ kind: string; message: string }> };
  assert.ok(logs.events.length >= 2);
  const kinds = logs.events.map((event) => event.kind);
  assert.ok(kinds.includes("memory.saved") && kinds.includes("run.failed"));
  assert.equal(logs.events[0].message, "second event", "newest first");

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  runtime.close();
});

test("web chat races: overlapping sends both persist; a send finishing after clear never resurrects its reply", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-chat-race-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(tempRoot, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";

  // Each stubbed run blocks until the test releases it — lets two sends overlap deterministically.
  const gates = new Map<string, () => void>();
  (runtime.agent as unknown as { run: unknown }).run = async (prompt: string) => {
    await new Promise<void>((resolve) => gates.set(prompt, resolve));
    return { runId: prompt, provider: "claude", response: `reply:${prompt}`, exitCode: 0, durationMs: 1, events: [] };
  };

  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const send = (prompt: string): Promise<Response> => fetch(`${base}/api/chat/send`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }),
  });
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const waitForGates = async (count: number): Promise<void> => {
    const deadline = Date.now() + 5_000;
    while (gates.size < count && Date.now() < deadline) await sleep(10);
    assert.equal(gates.size, count, `${count} send(s) should be blocked in flight`);
  };

  // Overlapping sends: release in reverse order so the final appends race hardest.
  const alpha = send("alpha");
  const beta = send("beta");
  await waitForGates(2);
  gates.get("beta")!();
  gates.get("alpha")!();
  await Promise.all([alpha, beta].map(async (pending) => (await pending).text()));
  const history = await (await fetch(`${base}/api/chat/history`)).json() as { messages: Array<{ role: string; text: string }> };
  assert.equal(history.messages.filter((m) => m.role === "henry").length, 2, "neither overlapping reply may be dropped by the other's write");
  assert.equal(history.messages.length, 4);

  // Clear while a send is still running: its reply must not reappear afterwards.
  gates.clear();
  const gamma = send("gamma");
  await waitForGates(1);
  await fetch(`${base}/api/chat/clear`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  gates.get("gamma")!();
  await (await gamma).text();
  const after = await (await fetch(`${base}/api/chat/history`)).json() as { messages: unknown[] };
  assert.equal(after.messages.length, 0, "a reply that finishes after clear must not resurrect into the fresh transcript");

  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  runtime.close();
});

test("dispatch registry: /api/dispatch records an agent, /api/agents returns the contract shape, and /api/events streams an agent event", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-agents-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(tempRoot, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  // Luna dispatches through its own internal ProviderRunner; swap it so the
  // test never spawns a real provider process.
  (runtime.luna as unknown as { runner: { run: unknown } }).runner = {
    run: async () => ({ runId: "run-1", provider: "codex", response: "Looked into it.\nmore detail", exitCode: 0, durationMs: 1, events: [] }),
  };

  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  try {
    const dispatchResponse = await fetch(`${base}/api/dispatch`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "architect", task: "look into the thing" }),
    });
    assert.equal(dispatchResponse.status, 200);

    const agents = await (await fetch(`${base}/api/agents`)).json() as {
      running: Array<{ id: string; role: string; task: string; provider: string; startedAt: string; status: string }>;
      recent: Array<{ id: string; role: string; task: string; provider: string; startedAt: string; finishedAt?: string; status: string; summary?: string }>;
    };
    assert.equal(agents.running.length, 0, "dispatch already resolved before we asked");
    assert.equal(agents.recent.length, 1);
    const entry = agents.recent[0];
    assert.equal(entry.role, "architect");
    assert.equal(entry.task, "look into the thing");
    assert.equal(entry.provider, "codex");
    assert.equal(entry.status, "done");
    assert.equal(entry.summary, "Looked into it.");
    assert.ok(entry.startedAt && entry.finishedAt);

    // /api/events replays the registry changelog since this connection's cursor
    // (0), so its very first tick carries both the running-start and the
    // done-settle "agent" events for the dispatch above — as two separate SSE
    // frames, possibly split across TCP chunks, so wait for the settled one
    // specifically. Uses raw node:http (not fetch) so the socket can be
    // force-destroyed afterwards: this endpoint's connection never ends on its
    // own, and an undici keep-alive socket left dangling after the test hangs
    // `server.close()` (and the whole suite).
    const buffer = await new Promise<string>((resolve, reject) => {
      const request = http.get(`${base}/api/events`, { agent: new http.Agent({ keepAlive: false }) }, (sseResponse) => {
        assert.equal(sseResponse.statusCode, 200);
        let collected = "";
        const deadline = setTimeout(() => { request.destroy(); resolve(collected); }, 5_000);
        sseResponse.on("data", (chunk: Buffer) => {
          collected += chunk.toString("utf8");
          if (collected.includes("event: agent") && collected.includes('"status":"done"')) { clearTimeout(deadline); request.destroy(); resolve(collected); }
        });
        sseResponse.on("error", () => { clearTimeout(deadline); resolve(collected); });
      });
      request.on("error", (error: NodeJS.ErrnoException) => {
        // Destroying the request ourselves also raises ECONNRESET/socket-hang-up here; that's expected teardown, not a failure.
        if (error.code === "ECONNRESET" || /socket hang up/.test(error.message)) return;
        reject(error);
      });
    });
    assert.match(buffer, /event: agent/);
    assert.match(buffer, /"role":"architect"/);
    assert.match(buffer, /"status":"done"/);
  } finally {
    // Always tear down, even on assertion failure: a dangling SSE connection
    // keeps the http.Server's event loop reference alive and hangs the whole
    // test run (this endpoint's connection never closes on its own). Force any
    // socket the destroy() above raced with closed too, so server.close()'s
    // callback can never be left waiting on it.
    server.closeAllConnections?.();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    runtime.close();
  }
});
