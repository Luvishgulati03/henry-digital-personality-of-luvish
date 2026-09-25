/**
 * Pure lint rules for the public knowledge pack's `draft/` files.
 *
 * Nothing here touches the filesystem — every function takes already-read file
 * contents and plain string lists, so the rules are unit-testable without a temp
 * dir and without the CLI. `src/public-pack/pack.ts` is the thin I/O layer that
 * reads `draft/*.md`, `denylist.txt`, and `allow.txt` and calls into this module.
 */

export interface DraftFile {
  /** File name relative to `draft/`, e.g. `profile.md`. */
  name: string;
  content: string;
}

export type LintSeverity = "error" | "warning";

export interface LintIssue {
  severity: LintSeverity;
  rule: string;
  file: string;
  /** 1-based line number, when the issue is line-scoped. */
  line?: number;
  message: string;
}

export interface LintResult {
  issues: LintIssue[];
  errors: LintIssue[];
  warnings: LintIssue[];
  ok: boolean;
  files: { name: string; bytes: number }[];
  totalBytes: number;
}

/** Total size cap for the whole `draft/` pack (concatenated into one public context). */
export const TOTAL_SIZE_CAP_BYTES = 60 * 1024;
/** A single file over this size is flagged as a soft warning ("very long file"). */
export const FILE_WARN_BYTES = 20 * 1024;

/** Parses a denylist/allowlist file: one term per line, `#`-prefixed comments and blank lines skipped. */
export function parseTermList(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Word-boundary aware so "Ann" doesn't flag "Anna" or "banner", case-insensitive throughout. */
function termRegExp(term: string): RegExp {
  // \b doesn't work at the edges of non-word characters (e.g. multi-word terms with
  // spaces already act as their own boundaries), so anchor on a lookaround that treats
  // start/end-of-string and non-word characters as boundaries either side of the term.
  return new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(term)}(?![A-Za-z0-9_])`, "i");
}

export function lintDenylist(files: DraftFile[], denylistTerms: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const terms = denylistTerms.filter(Boolean);
  if (terms.length === 0) return issues;
  const patterns = terms.map((term) => ({ term, pattern: termRegExp(term) }));
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { term, pattern } of patterns) {
        if (pattern.test(line)) {
          issues.push({
            severity: "error",
            rule: "denylist",
            file: file.name,
            line: index + 1,
            message: `Denylisted term "${term}" appears in draft content`,
          });
        }
      }
    });
  }
  return issues;
}

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "OpenAI-style secret key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
  { name: "GitHub personal access token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
  { name: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { name: "AWS access key ID", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "Bearer token", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}\b/i },
  { name: "Private key block", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // .env-style KEY=VALUE where the key name looks secret-shaped and the value is non-trivial.
  { name: ".env-style secret assignment", pattern: /\b[A-Z][A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD|PRIVATE_KEY)[A-Z0-9_]*\s*=\s*\S{4,}/ },
];

export function lintSecrets(files: DraftFile[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { name, pattern } of SECRET_PATTERNS) {
        if (pattern.test(line)) {
          issues.push({
            severity: "error",
            rule: "secret",
            file: file.name,
            line: index + 1,
            message: `Possible secret in draft content (${name})`,
          });
        }
      }
    });
  }
  return issues;
}

const LOCAL_PATH_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: "macOS/Linux home path", pattern: /\/Users\/[^\s"'`]+/ },
  { name: "tilde-relative path", pattern: /(?:^|[\s"'`(])~\/[^\s"'`)]+/ },
  { name: "Windows path", pattern: /[A-Za-z]:\\[^\s"'`]+/ },
];

export function lintLocalPaths(files: DraftFile[]): LintIssue[] {
  const issues: LintIssue[] = [];
  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { name, pattern } of LOCAL_PATH_PATTERNS) {
        if (pattern.test(line)) {
          issues.push({
            severity: "error",
            rule: "local-path",
            file: file.name,
            line: index + 1,
            message: `Local filesystem path found (${name})`,
          });
        }
      }
    });
  }
  return issues;
}

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// Loose "looks like a phone number" match: 7+ digits, optionally grouped/punctuated.
// Deliberately permissive (recall over precision) — false positives are cheap (a warning
// the owner reviews); a missed real phone number in a public file is not.
const PHONE_PATTERN = /(?:\+?\d[\d\s().-]{6,}\d)/g;

// Year ranges ("2021-2025", "2020 – 2024") and ISO dates ("2026-09-25") look like phone
// numbers to PHONE_PATTERN but are ordinary resume content.
const DATE_LIKE = /^(?:(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}|(?:19|20)\d{2}-\d{2}-\d{2})$/;

function normalizePhone(value: string): string {
  return value.replace(/\D/g, "");
}

export function lintContactInfo(files: DraftFile[], allowTerms: string[]): LintIssue[] {
  const issues: LintIssue[] = [];
  const allowedEmails = new Set(allowTerms.map((term) => term.toLowerCase()));
  const allowedPhones = new Set(allowTerms.map(normalizePhone).filter((digits) => digits.length >= 7));

  for (const file of files) {
    const lines = file.content.split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const match of line.matchAll(EMAIL_PATTERN)) {
        const email = match[0];
        if (email.toLowerCase().endsWith("@example.com")) continue;
        if (allowedEmails.has(email.toLowerCase())) continue;
        issues.push({
          severity: "error",
          rule: "email",
          file: file.name,
          line: index + 1,
          message: `Email address "${email}" is not in allow.txt`,
        });
      }
      for (const match of line.matchAll(PHONE_PATTERN)) {
        const digits = normalizePhone(match[0]);
        if (digits.length < 7) continue;
        if (DATE_LIKE.test(match[0].trim())) continue;
        if (allowedPhones.has(digits)) continue;
        issues.push({
          severity: "error",
          rule: "phone",
          file: file.name,
          line: index + 1,
          message: `Phone number "${match[0].trim()}" is not in allow.txt`,
        });
      }
    });
  }
  return issues;
}

export function lintSize(files: DraftFile[]): LintIssue[] {
  const issues: LintIssue[] = [];
  let total = 0;
  for (const file of files) {
    const bytes = Buffer.byteLength(file.content, "utf8");
    total += bytes;
    if (bytes > FILE_WARN_BYTES) {
      issues.push({
        severity: "warning",
        rule: "size",
        file: file.name,
        message: `File is ${bytes} bytes (over the ${FILE_WARN_BYTES}-byte soft warning threshold)`,
      });
    }
  }
  if (total > TOTAL_SIZE_CAP_BYTES) {
    issues.push({
      severity: "error",
      rule: "size",
      file: "(total)",
      message: `Draft pack is ${total} bytes, over the ${TOTAL_SIZE_CAP_BYTES}-byte total cap`,
    });
  }
  return issues;
}

/** Runs every rule and returns a combined, sorted result. */
export function lintDraft(files: DraftFile[], denylistTerms: string[], allowTerms: string[]): LintResult {
  const issues = [
    ...lintDenylist(files, denylistTerms),
    ...lintSecrets(files),
    ...lintLocalPaths(files),
    ...lintContactInfo(files, allowTerms),
    ...lintSize(files),
  ];
  const errors = issues.filter((issue) => issue.severity === "error");
  const warnings = issues.filter((issue) => issue.severity === "warning");
  const sizedFiles = files.map((file) => ({ name: file.name, bytes: Buffer.byteLength(file.content, "utf8") }));
  return {
    issues,
    errors,
    warnings,
    ok: errors.length === 0,
    files: sizedFiles,
    totalBytes: sizedFiles.reduce((sum, file) => sum + file.bytes, 0),
  };
}
