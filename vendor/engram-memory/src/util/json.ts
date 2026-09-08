/**
 * Extract the first parseable top-level JSON array from free-form LLM output.
 *
 * A greedy `\[[\s\S]*\]` regex breaks whenever prose around the array contains
 * a stray bracket ("Here are [my] tags: [...]") — the whole batch then silently
 * downgrades to fallback values. This walks candidate `[` starts, slices the
 * balanced span (string-aware, so brackets inside JSON strings don't count),
 * and returns the first slice that actually parses to an array.
 */
export function extractJsonArray(text: string): unknown[] | null {
  for (let start = text.indexOf("["); start !== -1; start = text.indexOf("[", start + 1)) {
    const candidate = balancedSlice(text, start);
    if (!candidate) continue;
    try {
      const v = JSON.parse(candidate) as unknown;
      if (Array.isArray(v)) return v;
    } catch {
      // not valid JSON from this start — try the next '['
    }
  }
  return null;
}

/** Slice from `start` (a `[`) to its matching `]`, or null if unbalanced. */
function balancedSlice(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") {
      depth--;
      if (depth === 0) return c === "]" ? text.slice(start, i + 1) : null;
    }
  }
  return null;
}
