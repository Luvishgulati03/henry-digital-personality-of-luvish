import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TunnelManager, tunnelModeFromEnv, type TunnelActivity, type TunnelConfig, type TunnelDeps } from "../src/remote/tunnel.ts";
import {
  TUNNEL_STILL_CONNECTING_MESSAGE, connectedLines, failedLine, waitForFirstTunnelTransition, watchTunnelTransitions, type TunnelAnnounceLine,
} from "../src/remote/announce.ts";
import { createTunnelFromEnv, resolveCloudflaredPath } from "../src/remote/env.ts";

/**
 * Henry's tunnel (ported from Kelly's kelly-tunnel tests, Cloudflare-only). Every process is a fake:
 * no test here can spawn cloudflared (tests/isolate.mjs also points HENRY_CLOUDFLARED_PATH at a
 * missing file and forces HENRY_TUNNEL=off).
 */

function fakeActivity(): { activity: TunnelActivity; events: Array<{ kind: string; message: string }> } {
  const events: Array<{ kind: string; message: string }> = [];
  return { activity: { record: async (kind, message) => { events.push({ kind, message }); return {}; } }, events };
}

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  killCalls: string[];
  kill: (signal?: string) => boolean;
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killCalls = [];
  child.kill = (signal?: string) => {
    child.killCalls.push(signal ?? "");
    setImmediate(() => child.emit("close", 0));
    return true;
  };
  return child;
}

const instantSleep = (): ((ms: number) => Promise<void>) => () => new Promise((resolve) => setImmediate(resolve));

async function waitFor(predicate: () => boolean, maxTicks = 2000): Promise<void> {
  for (let i = 0; i < maxTicks; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition not met in time");
}

function config(extra: Partial<TunnelConfig> = {}): TunnelConfig {
  return { mode: "cloudflare", port: 7337, cloudflaredPath: "cloudflared", cloudflareTunnel: "henry", ...extra };
}

function deps(spawned: FakeChild[], extra: Partial<TunnelDeps> = {}): TunnelDeps {
  return {
    which: async () => true,
    sleep: instantSleep(),
    preflight: () => undefined,
    spawn: (() => { const child = fakeChild(); spawned.push(child); return child; }) as unknown as TunnelDeps["spawn"],
    ...extra,
  };
}

test("tunnelModeFromEnv: only an explicit cloudflare turns the tunnel on", () => {
  assert.equal(tunnelModeFromEnv("cloudflare"), "cloudflare");
  for (const value of [undefined, "", "off", "funnel", "tailscale", "CLOUDFLARE", "on"]) assert.equal(tunnelModeFromEnv(value), "off");
});

test("off mode is a no-op and never touches a process", async () => {
  const { activity, events } = fakeActivity();
  let spawns = 0;
  const manager = new TunnelManager(config({ mode: "off" }), activity, { spawn: (() => { spawns += 1; return fakeChild(); }) as unknown as TunnelDeps["spawn"], which: async () => true });
  const status = await manager.start();
  assert.equal(status.active, false);
  assert.equal(status.mode, "off");
  assert.equal(spawns, 0);
  assert.equal(events.length, 0);
});

test("refuses to start without a named tunnel, without cloudflared, or without a published pack", async () => {
  const spawned: FakeChild[] = [];
  const { activity, events } = fakeActivity();
  const noName = await new TunnelManager(config({ cloudflareTunnel: undefined }), activity, deps(spawned)).start();
  assert.match(noName.lastError ?? "", /HENRY_CLOUDFLARE_TUNNEL is not set.*henry tunnel setup/);
  const noBinary = await new TunnelManager(config(), activity, deps(spawned, { which: async () => false })).start();
  assert.match(noBinary.lastError ?? "", /brew install cloudflared/);
  const noPack = await new TunnelManager(config(), activity, deps(spawned, { preflight: () => "No published public knowledge pack" })).start();
  assert.match(noPack.lastError ?? "", /No published public knowledge pack/);
  assert.equal(spawned.length, 0, "nothing is spawned when a precondition fails");
  assert.ok(events.every((event) => event.kind === "remote.failed"));
});

test("runs `cloudflared tunnel --no-autoupdate run --url http://127.0.0.1:<port> <name>` with no shell", async () => {
  const { activity } = fakeActivity();
  const calls: Array<{ cmd: string; args: string[]; options: unknown }> = [];
  const manager = new TunnelManager(config({ cloudflareTunnel: "henry-demo" }), activity, {
    which: async () => true, sleep: instantSleep(),
    spawn: ((cmd: string, args: string[], options: unknown) => { calls.push({ cmd, args, options }); return fakeChild(); }) as unknown as TunnelDeps["spawn"],
  });
  await manager.start();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "cloudflared");
  assert.deepEqual(calls[0].args, ["tunnel", "--no-autoupdate", "run", "--url", "http://127.0.0.1:7337", "henry-demo"]);
  assert.deepEqual(calls[0].options, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
  await manager.stop();
});

test("reports https://<HENRY_PUBLIC_HOST> once registered, never a hostname scraped from the log", async () => {
  const spawned: FakeChild[] = [];
  const { activity, events } = fakeActivity();
  const manager = new TunnelManager(config({ publicHost: "henry.example.com" }), activity, deps(spawned));
  await manager.start();
  assert.equal(manager.status().url, undefined);
  spawned[0].stdout.emit("data", Buffer.from("INF Registered tunnel connection to https://attacker.example.net\n"));
  assert.equal(manager.active, true);
  assert.equal(manager.status().url, "https://henry.example.com");
  assert.equal(manager.status().public, true);
  assert.ok(events.some((event) => event.kind === "remote.started"));
  await manager.stop();

  const bare: FakeChild[] = [];
  const unnamed = new TunnelManager(config(), activity, deps(bare));
  await unnamed.start();
  bare[0].stdout.emit("data", Buffer.from("INF Registered tunnel connection to https://abc.trycloudflare.com\n"));
  assert.equal(unnamed.status().url, undefined, "no HENRY_PUBLIC_HOST: no URL is invented");
  await unnamed.stop();
});

test("maps known cloudflared failures to a `henry tunnel setup` or network fix and keeps retrying", async () => {
  for (const [line, expected] of [
    ["failed to get origin cert: Cannot determine default origin certificate path", /henry tunnel setup henry\.example\.com/],
    ["failed to find tunnel: tunnel not found", /henry tunnel setup henry\.example\.com/],
    ["ERR failed to dial: dial tcp", /check the internet connection/i],
  ] as const) {
    const spawned: FakeChild[] = [];
    const { activity } = fakeActivity();
    const manager = new TunnelManager(config({ publicHost: "henry.example.com" }), activity, deps(spawned));
    await manager.start();
    spawned[0].stderr.emit("data", Buffer.from(`${line}\n`));
    spawned[0].emit("close", 1);
    await waitFor(() => manager.status().lastError !== undefined);
    assert.match(manager.status().lastError ?? "", expected);
    await waitFor(() => spawned.length >= 2);
    await manager.stop();
  }
});

test("an error AND a close from one child restart it once, not twice", async () => {
  const spawned: FakeChild[] = [];
  const { activity } = fakeActivity();
  const manager = new TunnelManager(config(), activity, deps(spawned));
  await manager.start();
  spawned[0].emit("error", new Error("spawn failed"));
  spawned[0].emit("close", 1);
  await waitFor(() => spawned.length >= 2);
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 2);
  await manager.stop();
});

test("stop sends SIGTERM, records remote.stopped, and no restart follows", async () => {
  const spawned: FakeChild[] = [];
  const { activity, events } = fakeActivity();
  const manager = new TunnelManager(config(), activity, deps(spawned));
  await manager.start();
  spawned[0].stdout.emit("data", Buffer.from("Registered tunnel connection\n"));
  await manager.stop();
  assert.equal(spawned[0].killCalls[0], "SIGTERM");
  assert.equal(manager.active, false);
  assert.ok(events.some((event) => event.kind === "remote.stopped"));
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(spawned.length, 1);
});

test("status() never carries a token-like string from cloudflared output", async () => {
  const spawned: FakeChild[] = [];
  const { activity, events } = fakeActivity();
  const manager = new TunnelManager(config(), activity, deps(spawned));
  await manager.start();
  const secret = "FAKE-BEARER-VALUE-that-must-never-appear-in-status-1234567890";
  spawned[0].stderr.emit("data", Buffer.from(`Authorization failed: Bearer ${secret}\n`));
  assert.ok(!JSON.stringify(manager.status()).includes(secret));
  for (const event of events) assert.ok(!JSON.stringify(event).includes(secret));
  await manager.stop();
});

test("createTunnelFromEnv: off by default; the preflight refuses while no pack is published", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-tunnel-env-"));
  const { activity } = fakeActivity();
  const off = createTunnelFromEnv({ port: 7337, dataDir, activity }, { HENRY_TUNNEL: "off" });
  assert.equal((await off.start()).mode, "off");
  const missing = path.join(dataDir, "missing", "cloudflared");
  const on = createTunnelFromEnv({ port: 7337, dataDir, activity }, { HENRY_TUNNEL: "cloudflare", HENRY_CLOUDFLARE_TUNNEL: "henry", HENRY_CLOUDFLARED_PATH: missing });
  const status = await on.start();
  assert.equal(status.active, false);
  assert.match(status.lastError ?? "", /public knowledge pack/);
  // With a pack published, the only thing left missing is the (deliberately absent) binary.
  fs.mkdirSync(path.join(dataDir, "public-pack", "published"), { recursive: true });
  fs.writeFileSync(path.join(dataDir, "public-pack", "published", "01-about.md"), "# About\nPublic facts.\n");
  const ready = await createTunnelFromEnv({ port: 7337, dataDir, activity }, { HENRY_TUNNEL: "cloudflare", HENRY_CLOUDFLARE_TUNNEL: "henry", HENRY_CLOUDFLARED_PATH: missing }).start();
  assert.match(ready.lastError ?? "", /was not found/);
  assert.equal(resolveCloudflaredPath({ HENRY_CLOUDFLARED_PATH: missing }), missing);
});

test("test isolation: the suite runs with the tunnel off and no real cloudflared", () => {
  assert.equal(process.env.HENRY_TUNNEL, "off");
  assert.ok(process.env.HENRY_CLOUDFLARED_PATH && !fs.existsSync(process.env.HENRY_CLOUDFLARED_PATH));
  assert.equal(process.env.HENRY_TEST_ISOLATION, "1");
});

/* ------------------------- announce ------------------------- */

test("announce: connected lines carry the public-face warning only on the first connect", () => {
  const status = { mode: "cloudflare" as const, active: true, url: "https://henry.example.com", restarts: 0, public: true };
  const first = connectedLines(status, false);
  assert.equal(first[0].text, "Remote access: https://henry.example.com");
  assert.match(first[1]?.text ?? "", /public face/);
  assert.equal(connectedLines(status, true).length, 1);
  assert.equal(failedLine("boom", true).text, "Remote access lost: boom");
  assert.match(TUNNEL_STILL_CONNECTING_MESSAGE, /henry tunnel status/);
});

test("announce: waits for the first transition, then prints one line per real change", async () => {
  const spawned: FakeChild[] = [];
  const { activity } = fakeActivity();
  const manager = new TunnelManager(config({ publicHost: "henry.example.com" }), activity, deps(spawned));
  await manager.start();
  const first = waitForFirstTunnelTransition(manager, 5_000);
  spawned[0].stdout.emit("data", Buffer.from("Registered tunnel connection\n"));
  const event = await first;
  assert.notEqual(event, "timeout");
  const lines: TunnelAnnounceLine[] = [];
  const unsubscribe = watchTunnelTransitions(manager, true, (line) => lines.push(line));
  spawned[0].emit("close", 1);
  await waitFor(() => spawned.length >= 2);
  spawned[1].stdout.emit("data", Buffer.from("Registered tunnel connection\n"));
  assert.deepEqual(lines.map((line) => line.text.split(":")[0]), ["Remote access lost", "Remote access reconnected"]);
  unsubscribe();
  await manager.stop();
});
