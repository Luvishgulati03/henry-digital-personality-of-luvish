import { createHash } from "node:crypto";

/** 32-bit FNV-1a hash. Fast, deterministic, good enough for feature hashing. */
export function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    // h *= 16777619, kept in 32-bit space via Math.imul
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Stable content fingerprint used to skip unchanged rows on re-index. */
export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Lowercase, hyphenate, strip noise — turns a path or title into a stable id. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/i, "") // drop file extension
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "mem";
}
