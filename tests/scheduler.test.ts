import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeCronFile, writeLaunchdPlist } from "../src/scheduler/install.ts";
import { WorkflowScheduler } from "../src/scheduler/scheduler.ts";
import { ActivityLog } from "../src/activity.ts";
import { loadConfig, type HenryConfig } from "../src/config.ts";
import type { HenryMemory } from "../src/memory/engram.ts";
import type { GmailService } from "../src/integrations/gmail.ts";
import type { WorkflowDefinition } from "../src/types.ts";

/** Runs `body` with the portfolio/GitHub variables (both env spellings) cleared, then restores them. */
async function withoutPortfolioEnv<T>(body: () => Promise<T>): Promise<T> {
  const keys = ["PORTFOLIO_DIR", "PORTFOLIO_SITE", "GITHUB_LOGIN"].flatMap((name) => [`HENRY_${name}`, `LAVU_${name}`]);
  const saved = keys.map((key) => [key, process.env[key]] as const);
  for (const key of keys) delete process.env[key];
  try { return await body(); }
  finally { for (const [key, value] of saved) if (value !== undefined) process.env[key] = value; }
}

test("scheduler installation writes reviewable cron and launchd artifacts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-scheduler-"));
  const config = { rootDir: root, dataDir: path.join(root, "data") } as HenryConfig;
  const workflows: WorkflowDefinition[] = [
    { id: "dream", name: "Dream", cron: "0 2 * * *", kind: "memory.dream", enabled: true },
    { id: "disabled", name: "Disabled", cron: "*/5 * * * *", kind: "gmail.inbox", enabled: false },
  ];
  const cron = await writeCronFile(config, workflows);
  const plist = await writeLaunchdPlist(config, workflows);
  assert.match(await fs.readFile(cron, "utf8"), /dream/);
  assert.match(await fs.readFile(plist, "utf8"), /com\.henry\.scheduler-1/);
  assert.match(await fs.readFile(plist, "utf8"), /schedule/);
});

/**
 * The FRAMEWORK ships with no portfolio repo and no GitHub account baked in: both are
 * configuration (HENRY_PORTFOLIO_DIR / HENRY_PORTFOLIO_SITE / HENRY_GITHUB_LOGIN), and an
 * unconfigured install must resolve them to "not set" rather than to the author's machine.
 */
test("portfolio and GitHub identity are configuration, with no baked-in defaults", async () => {
  await withoutPortfolioEnv(async () => {
    const bare = loadConfig(await fs.mkdtemp(path.join(os.tmpdir(), "henry-portfolio-defaults-")));
    assert.equal(bare.portfolioDir, undefined, "no portfolio path is baked in");
    assert.equal(bare.portfolioSite, undefined, "no portfolio URL is baked in");
    assert.equal(bare.githubLogin, undefined, "no GitHub account is baked in");

    process.env.HENRY_PORTFOLIO_DIR = "~/sites/mine";
    process.env.HENRY_PORTFOLIO_SITE = "https://example.github.io";
    process.env.HENRY_GITHUB_LOGIN = "octocat";
    const configured = loadConfig(await fs.mkdtemp(path.join(os.tmpdir(), "henry-portfolio-set-")));
    assert.equal(configured.portfolioDir, path.join(os.homedir(), "sites", "mine"), "~ expands, path is absolute");
    assert.equal(configured.portfolioSite, "https://example.github.io");
    assert.equal(configured.githubLogin, "octocat");
  });
});

/**
 * ...and the daily stats workflow must SKIP on either missing value instead of running `gh`
 * against somebody else's account. Both branches return before any filesystem or network work.
 */
test("portfolio stats workflow skips when the repo or the GitHub login is unconfigured", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "henry-portfolio-job-"));
  const config = {
    rootDir: root,
    dataDir: path.join(root, "data"),
    workflowsPath: path.join(root, "workflows.json"),
  } as HenryConfig;
  const activity = new ActivityLog(path.join(root, "data", "activity.jsonl"));
  await activity.init();
  const scheduler = new WorkflowScheduler(
    config, activity, undefined as unknown as HenryMemory, undefined as unknown as GmailService,
  );
  const definition: WorkflowDefinition = {
    id: "portfolio-stats-daily", name: "Portfolio stats", cron: "0 6 * * *", kind: "portfolio.stats", enabled: true,
  };

  const noRepo = await scheduler.run(definition) as { skipped?: boolean; reason?: string };
  assert.equal(noRepo.skipped, true);
  assert.match(noRepo.reason ?? "", /HENRY_PORTFOLIO_DIR/);

  // A configured repo but no account still skips — the contribution query needs a login.
  config.portfolioDir = path.join(root, "portfolio");
  const noLogin = await scheduler.run(definition) as { skipped?: boolean; reason?: string };
  assert.equal(noLogin.skipped, true);
  assert.match(noLogin.reason ?? "", /HENRY_GITHUB_LOGIN/);
});
