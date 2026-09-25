import fs from "node:fs/promises";
import path from "node:path";

/**
 * The public persona, read at RUNTIME from the owner's private, git-ignored persona files:
 *
 *   soul.md         only its "## Public mode (recruiters and visitors)" section (the heading must
 *                   start with "## Public mode"; the section runs to the next level-2 heading)
 *   personality.md  the voice and tone, whole (HTML comments stripped, capped)
 *
 * Nothing personal lives in code. When the soul section is missing, a safe generic rule set is used
 * instead, so a fresh clone never answers the public with the owner's private operating contract.
 */

export const PUBLIC_SECTION_HEADING = /^##\s+Public mode\b.*$/im;
const MAX_RULES_CHARS = 8_000;
const MAX_PERSONALITY_CHARS = 6_000;

export interface PublicPersona {
  /** The public-mode rules: the soul.md section, or the generic fallback. */
  rules: string;
  /** personality.md, or "" when absent. */
  personality: string;
  source: "soul" | "fallback";
}

function stripComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
}

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

/** The body of soul.md's "## Public mode ..." section, without its heading, or undefined. */
export function extractPublicSection(soul: string): string | undefined {
  const match = PUBLIC_SECTION_HEADING.exec(soul);
  if (!match || match.index === undefined) return undefined;
  const after = soul.slice(match.index + match[0].length);
  const next = after.search(/^##\s/m);
  const body = stripComments(next === -1 ? after : after.slice(0, next));
  return body || undefined;
}

export function fallbackPublicRules(ownerName: string): string {
  return [
    `You are Henry, ${ownerName}'s chief of staff and AI twin, speaking with visitors on ${ownerName}'s public page.`,
    "Be warm, brief, and professional. You represent the owner to recruiters, hiring managers, and curious visitors.",
    `Talk about ${ownerName} in the third person, using only the public knowledge pack you were given.`,
    `If the pack does not answer a question, say you don't know that yet and offer to pass a note to ${ownerName}.`,
    "Do not speculate about salary, availability, personal life, family, health, or anything not in the pack.",
  ].join("\n");
}

async function readText(filePath: string): Promise<string> {
  try { return await fs.readFile(filePath, "utf8"); } catch { return ""; }
}

export async function readPublicPersona(rootDir: string, ownerName: string): Promise<PublicPersona> {
  const [soul, personality] = await Promise.all([
    readText(path.join(rootDir, "soul.md")),
    readText(path.join(rootDir, "personality.md")),
  ]);
  const section = extractPublicSection(soul);
  return {
    rules: cap(section ?? fallbackPublicRules(ownerName), MAX_RULES_CHARS),
    personality: cap(stripComments(personality), MAX_PERSONALITY_CHARS),
    source: section ? "soul" : "fallback",
  };
}
