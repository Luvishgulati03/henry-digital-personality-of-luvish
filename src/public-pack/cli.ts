/**
 * Thin CLI layer for `henry public pack …`. All real logic lives in pack.ts (fs I/O) and
 * lint.ts (pure rules); this module only parses args, prints, and gates `publish` behind
 * confirmation. Wired from src/cli.ts's `command === "public"` branch.
 */
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import type { HenryConfig } from "../config.ts";
import {
  PublicPackLintError,
  initPublicPack,
  lintPublicPack,
  publishPublicPack,
  resolvePublicPackPaths,
  showPublicPack,
} from "./pack.ts";
import type { LintIssue, LintResult } from "./lint.ts";

function formatIssue(issue: LintIssue): string {
  const location = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  return `  [${issue.severity}] ${location} (${issue.rule}) ${issue.message}`;
}

function printLintSummary(lint: LintResult): void {
  console.log(`draft files: ${lint.files.length} (${lint.totalBytes} bytes total)`);
  for (const file of lint.files) console.log(`  - ${file.name} (${file.bytes} bytes)`);
  if (lint.issues.length === 0) {
    console.log("lint: clean — no errors or warnings");
    return;
  }
  if (lint.errors.length) {
    console.log(`lint errors (${lint.errors.length}):`);
    for (const issue of lint.errors) console.log(formatIssue(issue));
  }
  if (lint.warnings.length) {
    console.log(`lint warnings (${lint.warnings.length}):`);
    for (const issue of lint.warnings) console.log(formatIssue(issue));
  }
}

export async function runPublicPackCommand(config: HenryConfig, args: string[]): Promise<void> {
  const sub = args[0] || "show";
  const paths = resolvePublicPackPaths(config.dataDir);

  if (sub === "init") {
    const result = await initPublicPack(paths);
    console.log(`Public pack initialized at ${paths.root}`);
    if (result.created.length) {
      console.log("created:");
      for (const file of result.created) console.log(`  - ${file}`);
    }
    if (result.skipped.length) {
      console.log("already present (left untouched):");
      for (const file of result.skipped) console.log(`  - ${file}`);
    }
    console.log(`\nEdit files under ${paths.draftDir}, add private denylist/allow terms, then run:`);
    console.log("  henry public pack lint");
    console.log("  henry public pack publish");
    return;
  }

  if (sub === "lint") {
    const lint = await lintPublicPack(paths);
    printLintSummary(lint);
    if (!lint.ok) process.exitCode = 1;
    return;
  }

  if (sub === "show") {
    const result = await showPublicPack(paths);
    console.log(`draft: ${paths.draftDir}`);
    console.log(`published: ${paths.publishedDir}`);
    console.log(`last published: ${result.publishedManifest?.publishedAt ?? "(never published)"}`);
    console.log("draft files:");
    for (const file of result.draftFiles) console.log(`  - ${file.name} (${file.bytes} bytes)`);
    console.log("diff vs published:");
    const changed = result.diff.filter((entry) => entry.status !== "unchanged");
    if (changed.length === 0) console.log("  (no changes — published matches draft)");
    for (const entry of changed) console.log(`  - ${entry.status}: ${entry.name}`);
    console.log(`lint: ${result.lint.ok ? "clean" : `${result.lint.errors.length} error(s)`}, ${result.lint.warnings.length} warning(s)`);
    return;
  }

  if (sub === "publish") {
    const lint = await lintPublicPack(paths);
    printLintSummary(lint);
    if (!lint.ok) {
      console.log("\npublish refused: fix the lint error(s) above first.");
      process.exitCode = 1;
      return;
    }
    const autoYes = args.includes("--yes") || args.includes("-y");
    if (!autoYes) {
      if (!process.stdout.isTTY) {
        console.log("\npublish needs confirmation — rerun with --yes, or run this in an interactive terminal.");
        process.exitCode = 1;
        return;
      }
      const rl = readline.createInterface({ input, output });
      const answer = (await rl.question(`\nPublish ${lint.files.length} file(s) to ${paths.publishedDir}? [y/N] `)).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        console.log("Publish cancelled.");
        return;
      }
    }
    try {
      const result = await publishPublicPack(paths);
      console.log(`\nPublished ${result.manifest.files.length} file(s) at ${result.manifest.publishedAt}`);
      for (const file of result.manifest.files) console.log(`  - ${file.name} (${file.bytes} bytes, sha256 ${file.sha256.slice(0, 12)}…)`);
    } catch (error) {
      if (error instanceof PublicPackLintError) {
        console.log("\npublish refused: lint errors appeared between check and write — rerun `henry public pack lint`.");
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    return;
  }

  throw new Error("Usage: henry public pack init|lint|show|publish [--yes]");
}
