/**
 * Owner-side tooling for Henry's public knowledge pack.
 *
 * Layout under `<data dir>/public-pack/`:
 *   draft/*.md           — hand-written by the owner; never invented by code here.
 *   denylist.txt         — private, one term per line (# comments allowed).
 *   allow.txt            — optional private allowlist of contact values.
 *   published/*.md       — output of `publish`; the public server's reader concatenates these.
 *   published/.manifest.json — publishedAt, per-file sha256, lint summary.
 *
 * `publish()` is the owner's approval: it is never called from an automated path (see
 * the CLI layer in src/cli.ts, which only reaches this module from an interactive or
 * `--yes` owner invocation).
 */
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  type DraftFile,
  type LintResult,
  lintDraft,
  parseTermList,
} from "./lint.ts";

export interface PublicPackPaths {
  root: string;
  draftDir: string;
  publishedDir: string;
  denylistPath: string;
  allowPath: string;
  manifestPath: string;
}

export interface ManifestFileEntry {
  name: string;
  sha256: string;
  bytes: number;
}

export interface PublicPackManifest {
  publishedAt: string;
  files: ManifestFileEntry[];
  lint: { errorCount: number; warningCount: number };
}

export function resolvePublicPackPaths(dataDir: string): PublicPackPaths {
  const root = path.join(dataDir, "public-pack");
  const publishedDir = path.join(root, "published");
  return {
    root,
    draftDir: path.join(root, "draft"),
    publishedDir,
    denylistPath: path.join(root, "denylist.txt"),
    allowPath: path.join(root, "allow.txt"),
    manifestPath: path.join(publishedDir, ".manifest.json"),
  };
}

const EXAMPLE_DRAFT_FILES: Record<string, string> = {
  "profile.md": `# Profile

Your Name

One or two sentences describing who you are and what you do. This file is a
placeholder — replace it with real, public-safe content before publishing.

- Role: Your Title
- Focus: What you work on
- Contact: you@example.com
`,
  "resume.md": `# Resume

## Experience

- **Your Title** — Example Company (2020–present)
  - What you did, in one line.

## Skills

- Skill one, skill two, skill three
`,
  "projects.md": `# Projects

## Example Project

A short, public-safe description of a project you're proud of. Link to a
public repo or write-up if one exists (e.g. https://example.com/project).
`,
  "stories.md": `# Stories

## Example story

A short anecdote that shows how you work. Keep it public-safe: no client
names, no internal business names, no real contact details.
`,
  "faq.md": `# FAQ

## What do you work on?

Answer here.

## How can someone reach you?

you@example.com
`,
};

const DENYLIST_TEMPLATE = `# Henry public pack denylist
#
# One term per line, case-insensitive, word-boundary matched. Lines starting
# with # are comments. Add names and topics that must never appear in the
# public knowledge pack: client names, a family business name, former
# employers you don't want named, etc. This file itself is private and is
# never published.
#
# example-client-name
# example-family-business
`;

const ALLOW_TEMPLATE = `# Henry public pack allowlist
#
# One value per line: contact values (your own public email/phone) that ARE
# allowed to appear in the published pack, so \`henry public pack lint\`
# doesn't flag them. This file is private and is never published.
#
# you@example.com
`;

async function writeIfMissing(filePath: string, content: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return false;
  } catch {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, content, "utf8");
    return true;
  }
}

export interface InitResult {
  created: string[];
  skipped: string[];
}

/** Creates the folder layout and example files. Never overwrites an existing file. */
export async function initPublicPack(paths: PublicPackPaths): Promise<InitResult> {
  const created: string[] = [];
  const skipped: string[] = [];
  await fs.mkdir(paths.draftDir, { recursive: true });
  await fs.mkdir(paths.publishedDir, { recursive: true });

  for (const [name, content] of Object.entries(EXAMPLE_DRAFT_FILES)) {
    const filePath = path.join(paths.draftDir, name);
    const wrote = await writeIfMissing(filePath, content);
    (wrote ? created : skipped).push(path.relative(paths.root, filePath));
  }
  const wroteDenylist = await writeIfMissing(paths.denylistPath, DENYLIST_TEMPLATE);
  (wroteDenylist ? created : skipped).push(path.relative(paths.root, paths.denylistPath));
  const wroteAllow = await writeIfMissing(paths.allowPath, ALLOW_TEMPLATE);
  (wroteAllow ? created : skipped).push(path.relative(paths.root, paths.allowPath));

  return { created, skipped };
}

async function readMarkdownFiles(dir: string): Promise<DraftFile[]> {
  let entries: string[];
  try {
    entries = (await fs.readdir(dir)).filter((name) => name.endsWith(".md")).sort();
  } catch {
    return [];
  }
  const files: DraftFile[] = [];
  for (const name of entries) {
    const content = await fs.readFile(path.join(dir, name), "utf8");
    files.push({ name, content });
  }
  return files;
}

async function readTermList(filePath: string): Promise<string[]> {
  try {
    return parseTermList(await fs.readFile(filePath, "utf8"));
  } catch {
    return [];
  }
}

export async function readDraftFiles(paths: PublicPackPaths): Promise<DraftFile[]> {
  return readMarkdownFiles(paths.draftDir);
}

/** Lints `draft/` against `denylist.txt` and `allow.txt`. Pure rules live in lint.ts. */
export async function lintPublicPack(paths: PublicPackPaths): Promise<LintResult> {
  const [files, denylistTerms, allowTerms] = await Promise.all([
    readDraftFiles(paths),
    readTermList(paths.denylistPath),
    readTermList(paths.allowPath),
  ]);
  return lintDraft(files, denylistTerms, allowTerms);
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function readManifest(paths: PublicPackPaths): Promise<PublicPackManifest | null> {
  try {
    return JSON.parse(await fs.readFile(paths.manifestPath, "utf8")) as PublicPackManifest;
  } catch {
    return null;
  }
}

export interface DiffEntry {
  name: string;
  status: "added" | "changed" | "removed" | "unchanged";
}

export interface ShowResult {
  draftFiles: { name: string; bytes: number }[];
  publishedManifest: PublicPackManifest | null;
  diff: DiffEntry[];
  lint: LintResult;
}

/** Draft-vs-published status: files, sizes, a hash-based diff summary, and the last publish time. */
export async function showPublicPack(paths: PublicPackPaths): Promise<ShowResult> {
  const draftFiles = await readDraftFiles(paths);
  const manifest = await readManifest(paths);
  const lint = await lintPublicPack(paths);

  const publishedByName = new Map((manifest?.files ?? []).map((entry) => [entry.name, entry]));
  const draftNames = new Set(draftFiles.map((file) => file.name));
  const diff: DiffEntry[] = [];

  for (const file of draftFiles) {
    const published = publishedByName.get(file.name);
    if (!published) diff.push({ name: file.name, status: "added" });
    else if (published.sha256 !== sha256(file.content)) diff.push({ name: file.name, status: "changed" });
    else diff.push({ name: file.name, status: "unchanged" });
  }
  for (const published of publishedByName.values()) {
    if (!draftNames.has(published.name)) diff.push({ name: published.name, status: "removed" });
  }
  diff.sort((a, b) => a.name.localeCompare(b.name));

  return {
    draftFiles: draftFiles.map((file) => ({ name: file.name, bytes: Buffer.byteLength(file.content, "utf8") })),
    publishedManifest: manifest,
    diff,
    lint,
  };
}

export class PublicPackLintError extends Error {
  constructor(public readonly lint: LintResult) {
    super(`Public pack lint found ${lint.errors.length} error(s); publish refused`);
  }
}

export interface PublishResult {
  manifest: PublicPackManifest;
  lint: LintResult;
}

/**
 * Runs lint, refuses on any error, then atomically replaces `published/` (write to a
 * temp dir under the same parent, then rename) and writes the manifest. Callers are
 * responsible for interactive confirmation before calling this — running this function
 * IS the owner's approval to make the pack public.
 */
export async function publishPublicPack(paths: PublicPackPaths): Promise<PublishResult> {
  const files = await readDraftFiles(paths);
  const denylistTerms = await readTermList(paths.denylistPath);
  const allowTerms = await readTermList(paths.allowPath);
  const lint = lintDraft(files, denylistTerms, allowTerms);
  if (!lint.ok) throw new PublicPackLintError(lint);

  await fs.mkdir(paths.root, { recursive: true });
  const tempDir = await fs.mkdtemp(path.join(paths.root, ".publish-"));
  try {
    const fileEntries: ManifestFileEntry[] = [];
    for (const file of files) {
      await fs.writeFile(path.join(tempDir, file.name), file.content, "utf8");
      fileEntries.push({ name: file.name, sha256: sha256(file.content), bytes: Buffer.byteLength(file.content, "utf8") });
    }
    const manifest: PublicPackManifest = {
      publishedAt: new Date().toISOString(),
      files: fileEntries,
      lint: { errorCount: lint.errors.length, warningCount: lint.warnings.length },
    };
    await fs.writeFile(path.join(tempDir, ".manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    // Atomic swap: rename the old published dir out of the way, rename the new one in,
    // then remove the old one. A same-filesystem temp dir (sibling of published/, both
    // under root) keeps the rename atomic rather than a cross-device copy.
    const staleDir = path.join(paths.root, `.published-stale-${await tempSuffix()}`);
    let hadExisting = true;
    try {
      await fs.rename(paths.publishedDir, staleDir);
    } catch {
      hadExisting = false;
    }
    try {
      await fs.rename(tempDir, paths.publishedDir);
    } catch (error) {
      // Roll back so a failed swap never leaves `published/` missing.
      if (hadExisting) await fs.rename(staleDir, paths.publishedDir).catch(() => undefined);
      throw error;
    }
    if (hadExisting) await fs.rm(staleDir, { recursive: true, force: true });

    return { manifest, lint };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function tempSuffix(): Promise<string> {
  return `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Only used by tests that want a scratch data dir outside the repo/real deployment. */
export async function mkTempDataDir(prefix = "henry-public-pack-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
