import test from "node:test";
import assert from "node:assert/strict";
import {
  FILE_WARN_BYTES,
  TOTAL_SIZE_CAP_BYTES,
  lintContactInfo,
  lintDenylist,
  lintDraft,
  lintLocalPaths,
  lintSecrets,
  lintSize,
  parseTermList,
} from "../src/public-pack/lint.ts";
import type { DraftFile } from "../src/public-pack/lint.ts";

test("parseTermList strips comments and blank lines", () => {
  const parsed = parseTermList("# comment\nAcme Corp\n\n  Jane Example  # trailing comment\n");
  assert.deepEqual(parsed, ["Acme Corp", "Jane Example"]);
});

test("denylist matching is case-insensitive and word-boundary aware", () => {
  const files: DraftFile[] = [
    { name: "profile.md", content: "I worked with Acme Corp on a project.\nAcmeCorporate is unrelated." },
  ];
  const issues = lintDenylist(files, ["Acme Corp"]);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].line, 1);
  assert.equal(issues[0].file, "profile.md");
});

test("denylist does not false-positive on a substring inside a longer word", () => {
  const files: DraftFile[] = [{ name: "a.md", content: "Anna went to Annapolis." }];
  const issues = lintDenylist(files, ["Ann"]);
  assert.equal(issues.length, 0);
});

test("denylist still matches the term as a standalone word among longer lookalikes", () => {
  const files: DraftFile[] = [{ name: "a.md", content: "Ann said hello." }];
  const issues = lintDenylist(files, ["Ann"]);
  assert.equal(issues.length, 1);
});

test("secret detection flags common key shapes", () => {
  const files: DraftFile[] = [
    { name: "notes.md", content: "key: sk-abcdefghijklmnopqrstuvwx\ntoken: ghp_abcdefghijklmnopqrstuvwxyz0123456789" },
  ];
  const issues = lintSecrets(files);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.severity === "error"));
});

test("secret detection flags .env-style KEY=VALUE secrets", () => {
  const files: DraftFile[] = [{ name: "notes.md", content: "MY_API_KEY=abcd1234efgh5678" }];
  const issues = lintSecrets(files);
  assert.equal(issues.length, 1);
});

test("secret detection ignores ordinary prose", () => {
  const files: DraftFile[] = [{ name: "notes.md", content: "This is a normal sentence about my key skills." }];
  assert.equal(lintSecrets(files).length, 0);
});

test("local filesystem path detection", () => {
  const files: DraftFile[] = [
    { name: "a.md", content: "See /Users/example/project for the repo." },
    { name: "b.md", content: "Config lives at ~/dotfiles/henry" },
    { name: "c.md", content: "Windows path: C:\\Users\\example\\file.txt" },
    { name: "d.md", content: "No local path here, just prose." },
  ];
  const issues = lintLocalPaths(files);
  assert.equal(issues.filter((i) => i.file === "a.md").length, 1);
  assert.equal(issues.filter((i) => i.file === "b.md").length, 1);
  assert.equal(issues.filter((i) => i.file === "c.md").length, 1);
  assert.equal(issues.filter((i) => i.file === "d.md").length, 0);
});

test("email addresses are flagged unless allowlisted; example.com is always fine", () => {
  const files: DraftFile[] = [
    { name: "a.md", content: "Reach me at real.person@gmail.com or fake@example.com." },
  ];
  const flagged = lintContactInfo(files, []);
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].message.includes("real.person@gmail.com"), true);

  const allowed = lintContactInfo(files, ["real.person@gmail.com"]);
  assert.equal(allowed.length, 0);
});

test("phone numbers are flagged unless allowlisted, matching regardless of punctuation", () => {
  const files: DraftFile[] = [{ name: "a.md", content: "Call me at (555) 123-4567 today." }];
  const flagged = lintContactInfo(files, []);
  assert.equal(flagged.length, 1);

  const allowed = lintContactInfo(files, ["555-123-4567"]);
  assert.equal(allowed.length, 0);
});

test("size cap: per-file warning and total error", () => {
  const longFile: DraftFile = { name: "big.md", content: "x".repeat(FILE_WARN_BYTES + 1) };
  const warnOnly = lintSize([longFile]);
  assert.equal(warnOnly.length, 1);
  assert.equal(warnOnly[0].severity, "warning");

  const overCap: DraftFile = { name: "huge.md", content: "y".repeat(TOTAL_SIZE_CAP_BYTES + 1) };
  const errored = lintSize([overCap]);
  assert.ok(errored.some((issue) => issue.severity === "error" && issue.rule === "size"));
});

test("lintDraft aggregates all rules and reports ok=false on any error", () => {
  const files: DraftFile[] = [{ name: "a.md", content: "Contact real@gmail.com about Acme Corp." }];
  const result = lintDraft(files, ["Acme Corp"], []);
  assert.equal(result.ok, false);
  assert.ok(result.errors.length >= 2);
  assert.equal(result.files[0].name, "a.md");
});

test("lintDraft is clean for a safe draft", () => {
  const files: DraftFile[] = [{ name: "a.md", content: "Hello, I build software. Reach me at me@example.com." }];
  const result = lintDraft(files, ["Acme Corp"], []);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});
