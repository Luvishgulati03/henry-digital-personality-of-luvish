/**
 * A tiny, dependency-free frontmatter parser.
 *
 * It handles the subset of YAML that agent memory files actually use:
 *   - a leading `---` ... `---` block
 *   - top-level `key: value` pairs
 *   - one level of nesting (e.g. `metadata:` followed by indented `key: value`)
 *   - scalar coercion (numbers, booleans, quoted strings)
 *
 * It intentionally does NOT support the full YAML spec. For arbitrary YAML, plug
 * in `js-yaml` by replacing `parseFrontmatter`. Keeping it dependency-free is a
 * deliberate trade-off in service of "plug and play with zero install friction".
 */

export interface Frontmatter {
  data: Record<string, unknown>;
  body: string;
}

function coerce(raw: string): unknown {
  let v = raw.trim();
  if (v === "") return "";
  // strip matching quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~") return null;
  if (/^-?\d+$/.test(v)) return Number.parseInt(v, 10);
  if (/^-?\d*\.\d+$/.test(v)) return Number.parseFloat(v);
  return v;
}

export function parseFrontmatter(text: string): Frontmatter {
  const normalized = text.replace(/^﻿/, ""); // strip BOM
  const match = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(normalized);
  if (!match) return { data: {}, body: normalized };

  const block = match[1] ?? "";
  const body = normalized.slice(match[0].length);
  const data: Record<string, unknown> = {};
  let currentParent: string | null = null;

  for (const line of block.split("\n")) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    const indented = /^\s+/.test(line);
    const kv = /^(\s*)([A-Za-z0-9_.\- ]+):\s?(.*)$/.exec(line);
    if (!kv) continue;
    const key = (kv[2] ?? "").trim();
    const value = kv[3] ?? "";

    if (indented && currentParent) {
      const parent = (data[currentParent] as Record<string, unknown>) ?? {};
      parent[key] = coerce(value);
      data[currentParent] = parent;
      continue;
    }

    if (value.trim() === "") {
      // a key with no inline value opens a nested block
      data[key] = {};
      currentParent = key;
    } else {
      data[key] = coerce(value);
      currentParent = null;
    }
  }

  return { data, body };
}
