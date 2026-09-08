/**
 * Extract the first parseable top-level JSON array from free-form LLM output.
 *
 * A greedy `\[[\s\S]*\]` regex breaks whenever prose around the array contains
 * a stray bracket ("Here are [my] tags: [...]") — the whole batch then silently
 * downgrades to fallback values. This walks candidate `[` starts, slices the
 * balanced span (string-aware, so brackets inside JSON strings don't count),
 * and returns the first slice that actually parses to an array.
 */
export declare function extractJsonArray(text: string): unknown[] | null;
//# sourceMappingURL=json.d.ts.map