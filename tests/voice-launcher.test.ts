import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import {
  DEFAULT_KOKORO_URL, assertFree, maybeKeepAwake, publicPreflight, resolvePublicOrigin, resolveTunnelMode, startHenry, terminalCommand, waitForTunnelActive,
} from "../bin/start.mjs";

/* ------------------------------------------------------------------ *
 * `henry start --help`
 * ------------------------------------------------------------------ */

test("henry start --help documents --foreground and --public, and shows no --demo/--trade", async () => {
  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (value: string) => { lines.push(value); };
  try {
    await startHenry(["--help"]);
  } finally {
    console.log = originalLog;
  }
  const output = lines.join("\n");
  assert.ok(output.includes("--foreground"));
  assert.ok(!output.includes("--demo"));
  assert.ok(!output.includes("--trade"));
  assert.ok(output.includes("--public"));
  assert.match(output, /Without --public no public link is ever opened/);
});

test("henry start rejects unknown flags", async () => {
  await assert.rejects(() => startHenry(["--nope"]), /Usage: henry start/);
});

/* ------------------------------------------------------------------ *
 * Kokoro default port + port-collision check
 * ------------------------------------------------------------------ */

test("assertFree resolves for a free port and rejects when the port is taken", async () => {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  assert.ok(port > 0);

  await assert.rejects(() => assertFree(port), /already in use/);

  await new Promise<void>((resolve) => server.close(() => resolve()));
  await assertFree(port); // now free, should resolve without throwing
});

test("Henry's Kokoro worker defaults to port 8766, distinct from Kelly's 8765", () => {
  const url = new URL(DEFAULT_KOKORO_URL);
  assert.equal(url.port, "8766");
  assert.notEqual(url.port, "8765");
});

/* ------------------------------------------------------------------ *
 * `henry start --public [cloudflare]`
 * ------------------------------------------------------------------ */

test("resolveTunnelMode: off without --public; --public and --public cloudflare mean the Cloudflare named tunnel", () => {
  assert.equal(resolveTunnelMode([]), "off");
  assert.equal(resolveTunnelMode(["--foreground"]), "off");
  assert.equal(resolveTunnelMode(["--public"]), "cloudflare");
  assert.equal(resolveTunnelMode(["--public", "cloudflare"]), "cloudflare");
  assert.equal(resolveTunnelMode(["--public", "--foreground"]), "cloudflare");
  assert.throws(() => resolveTunnelMode(["--public", "funnel"]), /only cloudflare/);
});

test("henry start rejects unknown --public transports and still rejects stray flags", async () => {
  await assert.rejects(() => startHenry(["--public", "tailscale"]), /Usage: henry start|only cloudflare/);
  await assert.rejects(() => startHenry(["--public", "--demo"]), /Usage: henry start/);
});

test("terminalCommand forwards --public to the Terminal window", () => {
  assert.equal(terminalCommand("/usr/bin/node", "/x/henry.mjs"), "'/usr/bin/node' '/x/henry.mjs' 'start' '--foreground'");
  assert.equal(terminalCommand("/usr/bin/node", "/x/henry.mjs", true), "'/usr/bin/node' '/x/henry.mjs' 'start' '--foreground' '--public'");
});

test("resolvePublicOrigin: HENRY_PUBLIC_ORIGIN wins, else https://<HENRY_PUBLIC_HOST>", () => {
  assert.equal(resolvePublicOrigin({}), undefined);
  assert.equal(resolvePublicOrigin({ HENRY_PUBLIC_HOST: "henry.example.com" }), "https://henry.example.com");
  assert.equal(resolvePublicOrigin({ HENRY_PUBLIC_HOST: "henry.example.com", HENRY_PUBLIC_ORIGIN: "https://other.example.com" }), "https://other.example.com");
});

test("publicPreflight: needs `henry tunnel setup` and a non-empty published pack", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "henry-start-pack-"));
  const packDir = path.join(dir, "published");
  assert.match(await publicPreflight({}, packDir) ?? "", /henry tunnel setup/);
  assert.match(await publicPreflight({ HENRY_CLOUDFLARE_TUNNEL: "henry" }, packDir) ?? "", /HENRY_PUBLIC_HOST/);
  const env = { HENRY_CLOUDFLARE_TUNNEL: "henry", HENRY_PUBLIC_HOST: "henry.example.com" };
  assert.match(await publicPreflight(env, packDir) ?? "", /No published public knowledge pack/);
  await fs.mkdir(packDir, { recursive: true });
  await fs.writeFile(path.join(packDir, "a.md"), "  \n");
  assert.match(await publicPreflight(env, packDir) ?? "", /is empty/);
  await fs.writeFile(path.join(packDir, "b.md"), "# About\nFacts.");
  assert.equal(await publicPreflight(env, packDir), undefined);
});

test("maybeKeepAwake: caffeinate -i -w <pid> only on darwin with an active public link", () => {
  const calls: Array<{ cmd: string; args: string[] }> = [];
  const spawnProcess = ((cmd: string, args: string[]) => { calls.push({ cmd, args }); return {}; }) as never;
  const original = console.log;
  console.log = () => {};
  try {
    assert.equal(maybeKeepAwake("off", true, 42, { platform: "darwin", spawnProcess }), null);
    assert.equal(maybeKeepAwake("cloudflare", false, 42, { platform: "darwin", spawnProcess }), null);
    assert.equal(maybeKeepAwake("cloudflare", true, 42, { platform: "linux", spawnProcess }), null);
    assert.ok(maybeKeepAwake("cloudflare", true, 42, { platform: "darwin", spawnProcess }));
  } finally { console.log = original; }
  assert.deepEqual(calls, [{ cmd: "/usr/bin/caffeinate", args: ["-i", "-w", "42"] }]);
});

test("waitForTunnelActive: polls /api/health until remote.active, tolerates failures, gives up at the deadline", async () => {
  let polls = 0;
  const fetcher = (async () => {
    polls += 1;
    if (polls === 1) throw new Error("not up yet");
    if (polls === 2) return { json: async () => ({ ok: true }) };
    return { json: async () => ({ ok: true, remote: { active: polls >= 4 } }) };
  }) as unknown as typeof fetch;
  assert.equal(await waitForTunnelActive("http://127.0.0.1:1", { fetcher, intervalMs: 1, timeoutMs: 2_000 }), true);
  assert.equal(polls, 4);
  const never = (async () => ({ json: async () => ({ remote: { active: false } }) })) as unknown as typeof fetch;
  assert.equal(await waitForTunnelActive("http://127.0.0.1:1", { fetcher: never, intervalMs: 5, timeoutMs: 30 }), false);
});
