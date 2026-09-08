/**
 * Offline entity extraction — the cheap, deterministic glossary builder.
 *
 * "Entities" here are the salient nouns a memory is *about*: proper names
 * (Ada Lovelace, Socket Mode), acronyms (API, MCP), and code identifiers
 * (`relevance_score`, conversations.replies, sqlite-vec). They are the hooks
 * two otherwise-dissimilar memories share — "the deploy that broke the
 * `relevance_score` column" and "added a migration for `relevance_score`" have
 * little lexical overlap but are obviously *about* the same thing. Linking on
 * shared entities (`about` edges) and seeding recall from a query's entities is
 * what the roadmap calls precise, glossary-driven association.
 *
 * This is intentionally high-precision over high-recall: we'd rather miss a
 * fuzzy entity than flood the graph with noise edges. Richer NER can be swapped
 * in later (an LLM pass), but the default stays zero-dependency and offline.
 */

import { STOPWORDS } from "../util/text.js";

// Code identifiers: a word with an internal separator (snake/dot/kebab/slash)
// or interior camelCase. These are almost always meaningful and rarely noise.
const SEPARATED = /\b[A-Za-z][A-Za-z0-9]*(?:[._/-][A-Za-z0-9]+)+\b/g;
const CAMEL = /\b[a-z]+[A-Z][A-Za-z0-9]*\b/g;
// Acronyms: 2–6 uppercase letters (API, MCP, SQL, RRF), optional trailing s.
const ACRONYM = /\b[A-Z]{2,6}s?\b/g;
// Proper-noun phrases: runs of Capitalised words (Ada Lovelace, Socket Mode).
const PROPER = /\b[A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*\b/g;
// Backtick code spans.
const CODE_SPAN = /`([^`\n]+)`/g;

function norm(s: string): string {
  return s.trim().replace(/\s+/g, " ").toLowerCase();
}

function add(into: Set<string>, raw: string | undefined): void {
  if (!raw) return;
  const key = norm(raw);
  if (key.length < 2) return;
  if (/^\d+$/.test(key)) return; // pure numbers aren't entities
  if (!key.includes(" ") && STOPWORDS.has(key)) return; // single common word
  into.add(key);
}

/**
 * Extract the distinct salient entities from a piece of text. Returned keys are
 * normalised (lowercased, whitespace-collapsed) so they match glossary lookups.
 */
export function extractEntities(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();

  // Code spans: take the inner token if it's identifier-shaped (no spaces).
  for (const m of text.matchAll(CODE_SPAN)) {
    const inner = m[1]!.trim();
    if (inner && !/\s/.test(inner) && /[A-Za-z]/.test(inner)) add(out, inner);
  }
  for (const m of text.matchAll(SEPARATED)) add(out, m[0]);
  for (const m of text.matchAll(CAMEL)) add(out, m[0]);
  for (const m of text.matchAll(ACRONYM)) add(out, m[0]);

  for (const m of text.matchAll(PROPER)) {
    const phrase = m[0]!;
    // Keep multi-word proper phrases always; single Capitalised words only when
    // they're content-bearing (not a sentence-initial stopword) and ≥3 chars.
    if (phrase.includes(" ")) add(out, phrase);
    else if (phrase.length >= 3) add(out, phrase);
  }

  return [...out];
}
