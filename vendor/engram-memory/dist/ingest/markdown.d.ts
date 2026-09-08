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
/** Recursively list ingestible files under `dir` (skips dotfiles + node_modules). */
export declare function walk(dir: string, extensions?: string[]): string[];
/** Split text into memory-sized chunks per the chosen strategy. */
export declare function chunkContent(content: string, strategy: Exclude<ChunkStrategy, "auto">): string[];
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
export declare function canonicalTier(raw: string | null | undefined): string | undefined;
/** Turn one file into zero or more MemoryInputs. */
export declare function ingestFile(absPath: string, rootDir: string, opts?: IngestOptions): MemoryInput[];
/** Ingest every file under a directory into MemoryInputs (no DB writes here). */
export declare function ingestDirectory(dir: string, opts?: IngestOptions): MemoryInput[];
//# sourceMappingURL=markdown.d.ts.map