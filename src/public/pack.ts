import fs from "node:fs/promises";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

/**
 * READER for the published public knowledge pack. Building, linting and publishing the pack
 * belong to another module; this file only reads what was published:
 *
 *   <dataDir>/public-pack/published/*.md   sorted by name, each under a `=== <file> ===` header,
 *                                          concatenated and capped at `maxBytes` (default ~60 KB).
 *
 * Only regular `.md` files directly in that directory are read. Symlinks, subdirectories and odd
 * names are skipped, so a stray link can never pull a file from elsewhere into a public prompt.
 * A missing or empty pack is an error, never an empty string: public mode refuses to answer from
 * nothing.
 */

export interface PublicPack {
  ok: true;
  files: string[];
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface MissingPublicPack {
  ok: false;
  /** For the owner's terminal and logs only; never shown to a visitor. */
  reason: string;
}

const PACK_FILE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}\.md$/;

/** Cuts a UTF-8 string to at most `maxBytes` bytes without splitting a character. */
function clampBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString("utf8");
}

export async function readPublishedPack(dir: string, maxBytes = 60_000): Promise<PublicPack | MissingPublicPack> {
  let names: string[];
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    names = entries.filter((entry) => entry.isFile() && PACK_FILE.test(entry.name)).map((entry) => entry.name);
  } catch {
    return { ok: false, reason: `No published public knowledge pack at ${dir}. Publish one before turning on public mode.` };
  }
  names.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const parts: string[] = [];
  const files: string[] = [];
  for (const name of names) {
    const filePath = path.join(dir, name);
    try {
      const stat = await fs.lstat(filePath);
      if (!stat.isFile()) continue;
      const content = (await fs.readFile(filePath, "utf8")).replace(/\r\n/g, "\n").trim();
      if (!content) continue;
      files.push(name);
      parts.push(`=== ${name} ===\n${content}\n`);
    } catch {
      /* unreadable file: skipped, the rest of the pack still loads */
    }
  }
  if (!files.length) {
    return { ok: false, reason: `The public knowledge pack at ${dir} has no published .md files. Publish one before turning on public mode.` };
  }
  const joined = parts.join("\n");
  const bytes = Buffer.byteLength(joined, "utf8");
  const truncated = bytes > maxBytes;
  const text = truncated ? `${clampBytes(joined, maxBytes)}\n[pack truncated]` : joined;
  return { ok: true, files, text, bytes: Math.min(bytes, maxBytes), truncated };
}

/**
 * The pack, re-read at most every `ttlMs` so a republished pack is picked up without a restart
 * while a busy public face does not hit the disk on every turn.
 */
export class PublishedPackCache {
  private cached?: { at: number; value: PublicPack | MissingPublicPack };

  constructor(private readonly dir: string, private readonly maxBytes: number, private readonly ttlMs = 15_000, private readonly now: () => number = Date.now) {}

  async get(): Promise<PublicPack | MissingPublicPack> {
    const at = this.now();
    if (this.cached && at - this.cached.at < this.ttlMs) return this.cached.value;
    const value = await readPublishedPack(this.dir, this.maxBytes);
    this.cached = { at, value };
    return value;
  }
}

/** Synchronous readiness probe for startup gates (tunnel preflight, `henry start --public`). */
export function publishedPackProblem(dir: string): string | undefined {
  // Kept deliberately simple and sync: the full read happens per turn through the cache above.
  try {
    const names = readdirSync(dir).filter((name) => PACK_FILE.test(name));
    const nonEmpty = names.some((name) => {
      try {
        const filePath = path.join(dir, name);
        return lstatSync(filePath).isFile() && readFileSync(filePath, "utf8").trim().length > 0;
      } catch { return false; }
    });
    return nonEmpty ? undefined : `The public knowledge pack at ${dir} has no published .md files. Publish one before turning on public mode.`;
  } catch {
    return `No published public knowledge pack at ${dir}. Publish one before turning on public mode.`;
  }
}
