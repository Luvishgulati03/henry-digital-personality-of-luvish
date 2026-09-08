import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseFrontmatter } from "../util/frontmatter.js";
import { slugify } from "../util/hash.js";
import type { MemoryInput } from "../types.js";

export type ChunkStrategy = "auto" | "file" | "paragraph" | "heading";

export interface IngestOptions {
  /**
   * How to split a file into memories:
   *  - "file":      one memory per file
   *  - "paragraph": split on blank lines (good for daily logs / event streams)
   *  - "heading":   split on markdown headings
   *  - "auto":      "file" if the doc has frontmatter, else "paragraph" (default)
   */
  chunk?: ChunkStrategy;
  extensions?: string[];
}

const DEFAULT_EXTENSIONS = [".md", ".markdown", ".mdx", ".txt"];

/** Recursively list ingestible files under `dir` (skips dotfiles + node_modules). */
export function walk(dir: string, extensions = DEFAULT_EXTENSIONS): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(current, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        stack.push(full);
      } else if (extensions.some((e) => name.toLowerCase().endsWith(e))) {
        out.push(full);
      }
    }
  }
  return out.sort();
}

/** Split text into memory-sized chunks per the chosen strategy. */
export function chunkContent(content: string, strategy: Exclude<ChunkStrategy, "auto">): string[] {
  const text = content.trim();
  if (text === "") return [];
  switch (strategy) {
    case "file":
      return [text];
    case "paragraph": {
      const paras = text
        .split(/\n\s*\n/)
        .map((s) => s.trim())
        .filter(Boolean);
      // Attach a lone heading line (e.g. "# 2026-05-18") to the paragraph that
      // follows it, so the date/title travels with its first entry instead of
      // becoming a noisy standalone memory.
      const out: string[] = [];
      let pending = "";
      for (const p of paras) {
        const isLoneHeading = /^#{1,6}\s+\S/.test(p) && !p.includes("\n");
        if (isLoneHeading) {
          pending = pending ? `${pending}\n${p}` : p;
          continue;
        }
        out.push(pending ? `${pending}\n${p}` : p);
        pending = "";
      }
      if (pending) out.push(pending);
      return out;
    }
    case "heading": {
      const parts = text
        .split(/\n(?=#{1,6}\s)/)
        .map((s) => s.trim())
        .filter(Boolean);
      return parts.length ? parts : [text];
    }
  }
}

/**
 * engram's canonical tiers — the lifecycle machinery keys off these: `episodic`
 * is the transient tier promotion lifts FROM; `semantic`/`procedural` are the
 * durable tiers consolidation protects from forgetting.
 */
const CANONICAL_TIERS = new Set(["episodic", "semantic", "procedural", "working"]);

/**
 * Normalise whatever `tier`/`type` a writer used onto a canonical engram tier,
 * so promotion, forgetting, and tier-filtering treat every memory the same no
 * matter who wrote the file — auto-capture, a human, or the agent free-writing
 * markdown. The writer's original label is preserved in metadata; this only
 * decides which engram tier governs the memory's lifecycle.
 *
 * Returns `undefined` for untyped content so the store applies its own default
 * (we never invent a tier where the writer signalled none).
 */
export function canonicalTier(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim().toLowerCase();
  if (t === "") return undefined;
  if (CANONICAL_TIERS.has(t)) return t;
  // Hand-curated, durable knowledge (common agent memory taxonomies + synonyms).
  if (["feedback", "project", "reference", "user", "fact", "lesson", "rule", "note", "insight"].includes(t)) return "semantic";
  // Time-stamped conversational / log entries.
  if (["conversation", "daily", "exchange", "session", "episode", "log", "message"].includes(t)) return "episodic";
  // Step-by-step operational knowledge.
  if (["runbook", "howto", "procedure", "process", "checklist", "playbook"].includes(t)) return "procedural";
  // Explicitly typed but unrecognised → durable, never transient (so a typo
  // can't make a deliberate memory silently eligible for cold-archiving).
  return "semantic";
}

/**
 * Default salience for a file that declares none, keyed by canonical tier, so
 * hand-written durable memories (feedback/projects/references) outrank ambient
 * captured chatter instead of all defaulting to a flat 0.5.
 */
function defaultImportance(tier: string | undefined): number | undefined {
  switch (tier) {
    case "semantic":
    case "procedural":
      return 0.7;
    case "episodic":
      return 0.5;
    case "working":
      return 0.4;
    default:
      return undefined; // untyped → let the store apply its own default
  }
}

function parseDate(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return t;
  }
  return undefined;
}

/** Turn one file into zero or more MemoryInputs. */
export function ingestFile(absPath: string, rootDir: string, opts: IngestOptions = {}): MemoryInput[] {
  const raw = readFileSync(absPath, "utf8");
  const { data, body } = parseFrontmatter(raw);
  const hasFrontmatter = Object.keys(data).length > 0;
  const requested = opts.chunk ?? "auto";
  const strategy: Exclude<ChunkStrategy, "auto"> =
    requested === "auto" ? (hasFrontmatter ? "file" : "paragraph") : requested;

  const asString = (v: unknown): string | null =>
    typeof v === "string" && v.length > 0 ? v : null;

  const rel = relative(rootDir, absPath).split(sep).join("/");
  const baseId = slugify(asString(data.name) ?? rel);
  const meta =
    data.metadata && typeof data.metadata === "object"
      ? (data.metadata as Record<string, unknown>)
      : {};
  // Resolve the writer's tier signal from every convention seen in the wild:
  //   auto-capture → `tier`; nested → `metadata.type`; agent-curated → top-level
  //   `type`. Then canonicalise so the lifecycle machinery treats them alike.
  const rawTier = asString(data.tier) ?? asString(meta.type) ?? asString(data.type);
  const tier = canonicalTier(rawTier);
  const importance =
    typeof data.importance === "number" ? data.importance : defaultImportance(tier);
  const createdAt =
    parseDate(data.date) ?? parseDate(data.created_at) ?? statSync(absPath).mtimeMs;

  const chunks = chunkContent(body, strategy);
  const memories: MemoryInput[] = [];
  chunks.forEach((chunk, i) => {
    const id = chunks.length > 1 ? `${baseId}::${i}` : baseId;
    memories.push({
      id,
      content: chunk,
      source: rel,
      tier,
      importance,
      createdAt,
      metadata: {
        ...data,
        _file: rel,
        _chunkIndex: i,
        _chunkStrategy: strategy,
      },
    });
  });
  return memories;
}

/** Ingest every file under a directory into MemoryInputs (no DB writes here). */
export function ingestDirectory(dir: string, opts: IngestOptions = {}): MemoryInput[] {
  const files = walk(dir, opts.extensions);
  const out: MemoryInput[] = [];
  for (const f of files) out.push(...ingestFile(f, dir, opts));
  return out;
}
