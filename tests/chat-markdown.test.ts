import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";

/**
 * chat.html's markdown renderer is an inline closure (not an importable module), so it is
 * exercised through a real browser instead of a unit import: window.__henryRenderMarkdown is
 * the same function the transcript uses for every Henry reply. Covers GitHub-style tables
 * (headers, alignment, inline formatting in cells, escaping) alongside a code block and a
 * list, to make sure the table branch does not break the rest of the renderer.
 */

async function launch(): Promise<Browser | undefined> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return undefined;
  }
}

test("chat.html markdown renderer: tables, code blocks and lists", { timeout: 60000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-chat-markdown-"));
  fs.cpSync(path.join(process.cwd(), "workflows"), path.join(tempRoot, "workflows"), { recursive: true });
  const runtime = await HenryRuntime.create(tempRoot);
  runtime.config.port = 0;
  runtime.config.host = "127.0.0.1";
  const server = startDashboard(runtime);
  await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;

  const browser = await launch();
  if (!browser) {
    t.skip("Playwright Chromium is not installed");
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
    return;
  }

  try {
    const page = await browser.newPage();
    await page.goto(base + "/chat", { waitUntil: "networkidle" });

    const sample = [
      "Here is a summary:",
      "",
      "| Name  | Score | Note        |",
      "| :---- | ----: | :---------- |",
      "| Alice | 42    | **great**   |",
      "| Bob   | 7     | plain <b>x</b> |",
      "",
      "And a list:",
      "- one",
      "- two",
      "",
      "```js",
      "console.log(1)",
      "```",
    ].join("\n");

    const html: string = await page.evaluate((src) => (window as any).__henryRenderMarkdown(src), sample);

    // Table structure: one header row, two body rows, wrapped for horizontal scroll.
    assert.match(html, /<div class="table-wrap"><table>/, "table not wrapped in a scrollable container");
    assert.match(html, /<th[^>]*>Name<\/th>/, "header cell missing");
    assert.match(html, /<td[^>]*><strong>great<\/strong><\/td>/, "inline formatting inside a cell was not applied");
    // Alignment: the separator's trailing colon on "Score" means right-aligned; the numeric
    // "42"/"7" cells also read as numeric and should right-align even without an explicit colon
    // on every column.
    assert.match(html, /<th style="text-align:right">Score<\/th>/, "declared right alignment missing");
    // Escaping: a literal "<b>" typed in a reply must render as text, never as real markup.
    assert.match(html, /plain &lt;b&gt;x&lt;\/b&gt;/, "raw HTML in a table cell was not escaped");
    assert.doesNotMatch(html, /<b>x<\/b>/, "table cell content injected raw HTML");

    // The list and code block around the table must still render normally.
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/, "list after a table did not render");
    assert.match(html, /<div class="codeblock">/, "code block after a table did not render");
    assert.match(html, /<code>console\.log\(1\)<\/code>/, "code block content missing/escaped wrong");

    // A lone pipe with no separator row underneath must stay plain text, not become a table.
    const notATable: string = await page.evaluate(
      (src) => (window as any).__henryRenderMarkdown(src),
      "throughput | latency\nnot a table, just prose with a pipe",
    );
    assert.doesNotMatch(notATable, /<table>/, "a stray pipe line was mistaken for a table");

    await page.close();
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
  }
});
