/**
 * THE TEST SUITE MUST NEVER TOUCH THE REPO'S `data/`.
 *
 * Preloaded by `npm test` (package.json: `tsx --import ./tests/isolate.mjs --test …`), before
 * a single test module is evaluated, so it is in place no matter which file runs first.
 *
 * Why a preload and not a line in each test's freshEnv(): a module resolves its database as
 * `process.env.HENRY_DATA_DIR || process.env.LAVU_DATA_DIR || "data"` AT CALL TIME, and a test
 * only escapes the repo for the modules it remembered to `configure*()`. That list is a promise
 * every test file has to keep about a graph it does not import directly — a single surface
 * reaches a dozen DB-opening modules — and it was already broken: the P5 audit found rows
 * sitting in this deployment's real database, written because those files configured the
 * modules they knew about and a newer one had been added underneath them.
 *
 * So the fallback itself is moved. A module a test forgot to point at a tmpdir now lands in a
 * scratch directory instead of the live deployment, and the next DB-opening module is covered
 * on the day it lands rather than on the day someone notices.
 *
 * `src/config.ts` resolves the WHOLE deployment's dataDir from the same variable
 * (`env("DATA_DIR")` → `HENRY_DATA_DIR` / `LAVU_DATA_DIR`), so engram.db, activity.jsonl,
 * settings.json and the rest of the agent's state move with it. A test that forgot to point at
 * a tmpdir was writing into the running deployment; now it cannot.
 *
 * An already-set HENRY_DATA_DIR (or the legacy LAVU_DATA_DIR) is honoured rather than
 * overwritten, so a developer can point a run somewhere specific and still get the guard.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

if (!process.env.HENRY_DATA_DIR && !process.env.LAVU_DATA_DIR) {
  process.env.HENRY_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "henry-test-data-"));
}

/**
 * THE TEST SUITE MUST NEVER SEE THE OWNER'S PUBLIC LINK OR SECRETS, AND NEVER START A REAL TUNNEL
 * (ported from Kelly's tests/isolate.mjs).
 *
 *  1. HENRY_TEST_ISOLATION=1 makes src/config.ts skip dotenv, so neither the repo `.env` nor a cwd
 *     `.env` reaches a test process (it can carry a live tunnel, Telegram credentials, the owner's
 *     name). dotenv only fills unset variables, so a test that deletes a key would otherwise get
 *     the owner's value back.
 *  2. Every public-link variable is set explicitly to its off/empty meaning, even if the developer's
 *     shell exported it: HENRY_TUNNEL=off, and the tunnel name, public host/origin, and health CORS
 *     list blank. Owner-facing values (Telegram, owner name) are cleared too.
 *  3. HENRY_CLOUDFLARED_PATH points inside a fresh temp dir at a file that does not exist, so even
 *     a test that turns the tunnel on can only ever spawn ENOENT, never the real cloudflared.
 *  4. HENRY_DASH_SECRET gets a random per-process value: without a `.env` the dashboard would
 *     otherwise generate one and APPEND it to the repo `.env` (src/dashboard/auth.ts).
 */
process.env.HENRY_TEST_ISOLATION = "1";
process.env.HENRY_TUNNEL = "off";
process.env.HENRY_CLOUDFLARE_TUNNEL = "";
process.env.HENRY_PUBLIC_HOST = "";
process.env.HENRY_PUBLIC_ORIGIN = "";
process.env.HENRY_HEALTH_CORS_ORIGINS = "";
process.env.HENRY_TELEGRAM_BOT_TOKEN = "";
process.env.HENRY_TELEGRAM_CHAT_ID = "";
delete process.env.HENRY_OWNER_NAME;
delete process.env.HENRY_REMOTE_ADMIN;
delete process.env.HENRY_PUBLIC_TURN;
for (const key of Object.keys(process.env)) {
  if (key.startsWith("HENRY_PUBLIC_") && !["HENRY_PUBLIC_HOST", "HENRY_PUBLIC_ORIGIN"].includes(key)) delete process.env[key];
}
{
  const { randomBytes } = await import("node:crypto");
  const noBinaryDir = fs.mkdtempSync(path.join(os.tmpdir(), "henry-isolated-no-binaries-"));
  process.env.HENRY_CLOUDFLARED_PATH = path.join(noBinaryDir, "missing", "cloudflared");
  process.env.HENRY_DASH_SECRET = randomBytes(32).toString("hex");
}
