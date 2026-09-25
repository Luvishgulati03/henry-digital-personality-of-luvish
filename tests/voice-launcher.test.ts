import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { DEFAULT_KOKORO_URL, assertFree, startHenry } from "../bin/start.mjs";

/* ------------------------------------------------------------------ *
 * `henry start --help`
 * ------------------------------------------------------------------ */

test("henry start --help documents --foreground and shows no --demo/--trade/--public", async () => {
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
  assert.ok(!output.includes("--public"));
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
