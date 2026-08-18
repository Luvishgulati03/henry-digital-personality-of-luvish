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
