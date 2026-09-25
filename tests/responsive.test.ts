import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { HenryRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/dashboard/server.ts";

/**
 * Scripted mobile/tablet checks (see docs/responsive audit) against the real dashboard pages:
 * no horizontal scroll, inputs stay >=16px (iOS focus-zoom), and the main controls stay
 * >=44x44 CSS px. Runs the three surfaces most used from a phone/iPad — /login, /talk, /chat —
 * at one phone and one tablet viewport. A dedicated hover:none, coarse-pointer offender list is
 * intentionally excluded here: it just needs to be narrow enough to catch a regression cheaply,
 * not to be the full audit.
 */

const VIEWPORTS = [
  { name: "390x844 (phone)", width: 390, height: 844 },
  { name: "768x1024 (tablet)", width: 768, height: 1024 },
];

/** Selectors whose real hit area is intentionally smaller than 44px but padded out with a
 * ::before/::after pseudo-element (a getBoundingClientRect-based check cannot see that padding). */
const PSEUDO_PADDED = new Set([".conv .act", ".codeblock-bar button", ".switch"]);

async function launch(): Promise<Browser | undefined> {
  try {
    return await chromium.launch({ headless: true });
  } catch {
    return undefined;
  }
}

async function checkPage(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    innerWidth: window.innerWidth,
  }));
  assert.ok(
    overflow.scrollWidth <= overflow.innerWidth + 1,
    `${label}: horizontal scroll (scrollWidth=${overflow.scrollWidth} > innerWidth=${overflow.innerWidth})`,
  );

  const meta = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "");
  assert.match(meta, /width=device-width/, `${label}: viewport meta missing width=device-width`);
  assert.match(meta, /initial-scale=1/, `${label}: viewport meta missing initial-scale=1`);

  const smallFonts = await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll("input, select, textarea"));
    const bad: string[] = [];
    for (const el of els as HTMLElement[]) {
      const type = (el as HTMLInputElement).type;
      if (type === "checkbox" || type === "radio" || type === "hidden") continue;
      const style = getComputedStyle(el);
      if (style.display === "none") continue;
      const size = parseFloat(style.fontSize);
      if (size < 16) bad.push(`${el.id ? "#" + el.id : el.tagName.toLowerCase()} (${size}px)`);
    }
    return bad;
  });
  assert.deepEqual(smallFonts, [], `${label}: inputs under 16px font-size (iOS zoom risk)`);

  const offenders = await page.evaluate((pseudoPadded: string[]) => {
    const els = Array.from(document.querySelectorAll('button, a[href], input, select, textarea, [role="button"], summary'));
    const bad: string[] = [];
    for (const el of els as HTMLElement[]) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") continue;
      if (el.hasAttribute("hidden") || el.closest("[hidden]")) continue;
      if (pseudoPadded.some((sel) => el.matches(sel) || el.closest(sel))) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (el.tagName === "A" && el.closest(".prose, p, .msg, .row-copy, footer, .subtitle")) continue;
      if (el.tagName === "INPUT" && (el as HTMLInputElement).type === "hidden") continue;
      if (el.tagName === "INPUT" && ((el as HTMLInputElement).type === "checkbox" || (el as HTMLInputElement).type === "radio")) {
        const label = el.closest("label") || (el.id ? document.querySelector(`label[for="${el.id}"]`) : null);
        if (label) { const r = label.getBoundingClientRect(); if (r.width >= 44 && r.height >= 44) continue; }
      }
      if (rect.width < 44 || rect.height < 44) {
        const sel = el.id ? "#" + el.id : el.tagName.toLowerCase() + (el.className && typeof el.className === "string" ? "." + el.className.split(" ").filter(Boolean).slice(0, 2).join(".") : "");
        bad.push(`${sel} (${Math.round(rect.width)}x${Math.round(rect.height)})`);
      }
    }
    return bad;
  }, Array.from(PSEUDO_PADDED));
  assert.deepEqual(offenders, [], `${label}: tap targets under 44x44 CSS px`);
}

test("responsive: /login, /talk, /chat pass the scripted mobile/tablet checks", { timeout: 120000 }, async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "henry-responsive-"));
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
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height },
        isMobile: viewport.width < 500,
        hasTouch: true,
        deviceScaleFactor: 2,
      });
      for (const route of ["/login", "/talk", "/chat"]) {
        const page = await context.newPage();
        await page.goto(base + route, { waitUntil: "networkidle" });
        await checkPage(page, `${route} @ ${viewport.name}`);
        await page.close();
      }
      await context.close();
    }
  } finally {
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    runtime.close();
  }
});
