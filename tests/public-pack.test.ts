import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  PublicPackLintError,
  initPublicPack,
  lintPublicPack,
  publishPublicPack,
  resolvePublicPackPaths,
  showPublicPack,
} from "../src/public-pack/pack.ts";

async function tempDataDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "henry-public-pack-test-"));
}

test("init creates the folder layout with placeholder-only drafts and never overwrites", async () => {
  const dataDir = await tempDataDir();
  const paths = resolvePublicPackPaths(dataDir);

  const first = await initPublicPack(paths);
  assert.ok(first.created.length > 0);
  assert.equal(first.skipped.length, 0);

  // Draft content is placeholder-only — no personal info, only example.com / "Your Name".
  const profile = await fs.readFile(path.join(paths.draftDir, "profile.md"), "utf8");
  assert.match(profile, /Your Name/);
  assert.match(profile, /example\.com/);

  // Owner edits a file, then init runs again — must not clobber the edit.
  await fs.writeFile(path.join(paths.draftDir, "profile.md"), "# Edited\nReal content the owner wrote.\n", "utf8");
  const second = await initPublicPack(paths);
  assert.equal(second.created.length, 0);
  assert.ok(second.skipped.length > 0);
  const stillEdited = await fs.readFile(path.join(paths.draftDir, "profile.md"), "utf8");
  assert.match(stillEdited, /Real content the owner wrote/);
});

test("lintPublicPack reads denylist.txt and allow.txt from disk", async () => {
  const dataDir = await tempDataDir();
  const paths = resolvePublicPackPaths(dataDir);
  await initPublicPack(paths);
  await fs.writeFile(paths.denylistPath, "Acme Corp\n", "utf8");
  await fs.writeFile(path.join(paths.draftDir, "leak.md"), "I used to work at Acme Corp doing things.", "utf8");

  const lint = await lintPublicPack(paths);
  assert.equal(lint.ok, false);
  assert.ok(lint.errors.some((issue) => issue.rule === "denylist" && issue.file === "leak.md"));
});

test("publish refuses on lint errors and does not touch published/", async () => {
  const dataDir = await tempDataDir();
  const paths = resolvePublicPackPaths(dataDir);
  await initPublicPack(paths);
  await fs.writeFile(path.join(paths.draftDir, "leak.md"), "My secret key is sk-abcdefghijklmnopqrstuvwx", "utf8");

  await assert.rejects(() => publishPublicPack(paths), PublicPackLintError);
  const manifestExists = await fs.access(paths.manifestPath).then(() => true, () => false);
  assert.equal(manifestExists, false);
});

test("publish atomically writes published/ and a manifest with sha256 per file", async () => {
  const dataDir = await tempDataDir();
  const paths = resolvePublicPackPaths(dataDir);
  await initPublicPack(paths);
  // Remove the example drafts down to one small, clean file for a deterministic manifest.
  for (const name of await fs.readdir(paths.draftDir)) await fs.rm(path.join(paths.draftDir, name));
  await fs.writeFile(path.join(paths.draftDir, "profile.md"), "# Profile\nHello, I build things. me@example.com\n", "utf8");

  const result = await publishPublicPack(paths);
  assert.equal(result.lint.ok, true);
  assert.equal(result.manifest.files.length, 1);
  assert.equal(result.manifest.files[0].name, "profile.md");
  assert.match(result.manifest.files[0].sha256, /^[0-9a-f]{64}$/);

  const published = await fs.readFile(path.join(paths.publishedDir, "profile.md"), "utf8");
  assert.match(published, /Hello, I build things/);
  const manifestOnDisk = JSON.parse(await fs.readFile(paths.manifestPath, "utf8"));
  assert.equal(manifestOnDisk.files.length, 1);
});

test("publish replaces stale published content rather than merging with it", async () => {
  const dataDir = await tempDataDir();
  const paths = resolvePublicPackPaths(dataDir);
  await initPublicPack(paths);
  for (const name of await fs.readdir(paths.draftDir)) await fs.rm(path.join(paths.draftDir, name));

  await fs.writeFile(path.join(paths.draftDir, "one.md"), "First publish content.\n", "utf8");
  await publishPublicPack(paths);
  assert.ok(await fs.access(path.join(paths.publishedDir, "one.md")).then(() => true, () => false));

  await fs.rm(path.join(paths.draftDir, "one.md"));
  await fs.writeFile(path.join(paths.draftDir, "two.md"), "Second publish content.\n", "utf8");
  const second = await publishPublicPack(paths);

  assert.equal(second.manifest.files.length, 1);
  assert.equal(second.manifest.files[0].name, "two.md");
  const oneStillThere = await fs.access(path.join(paths.publishedDir, "one.md")).then(() => true, () => false);
  assert.equal(oneStillThere, false);
});

test("showPublicPack reports added/changed/removed against the last manifest", async () => {
  const dataDir = await tempDataDir();
  const paths = resolvePublicPackPaths(dataDir);
  await initPublicPack(paths);
  for (const name of await fs.readdir(paths.draftDir)) await fs.rm(path.join(paths.draftDir, name));
  await fs.writeFile(path.join(paths.draftDir, "keep.md"), "Unchanged content.\n", "utf8");
  await fs.writeFile(path.join(paths.draftDir, "edit.md"), "Original content.\n", "utf8");
  await publishPublicPack(paths);

  await fs.writeFile(path.join(paths.draftDir, "edit.md"), "Updated content.\n", "utf8");
  await fs.writeFile(path.join(paths.draftDir, "new.md"), "Brand new content.\n", "utf8");
  await fs.rm(path.join(paths.draftDir, "keep.md"));

  const result = await showPublicPack(paths);
  const byName = Object.fromEntries(result.diff.map((entry) => [entry.name, entry.status]));
  assert.equal(byName["edit.md"], "changed");
  assert.equal(byName["new.md"], "added");
  assert.equal(byName["keep.md"], "removed");
  assert.equal(result.publishedManifest !== null, true);
});
