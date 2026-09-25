import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { publicHarness } from "./public-harness.ts";

/**
 * The public faces are phone-first: at 360px (and a tablet), no horizontal scroll, the viewport
 * meta, 16px inputs (no iOS zoom), and 44x44 tap targets. The landing page is only served through
 * the tunnel, so the browser context carries Cloudflare's headers.
 */

const VIEWPORTS = [
  { name: "360x740 (small phone)", width: 360, height: 740 },
  { name: "768x1024 (tablet)", width: 768, height: 1024 },
];

async function launch(): Promise<Browser | undefined> {
  try { return await chromium.launch({ headless: true }); } catch { return undefined; }
}

async function checkPage(page: Page, label: string): Promise<void> {
  const overflow = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth }));
  assert.ok(overflow.scrollWidth <= overflow.innerWidth + 1, `${label}: horizontal scroll (${overflow.scrollWidth} > ${overflow.innerWidth})`);
  const meta = await page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute("content") || "");
  assert.match(meta, /width=device-width/);
  assert.match(meta, /initial-scale=1/);
  const problems = await page.evaluate(() => {
    const bad: string[] = [];
    for (const el of Array.from(document.querySelectorAll("input, textarea")) as HTMLElement[]) {
      const style = getComputedStyle(el);
      if (style.display !== "none" && !el.closest("dialog:not([open])") && parseFloat(style.fontSize) < 16) bad.push(`font ${el.tagName}`);
    }
    for (const el of Array.from(document.querySelectorAll('button, a[href], input, textarea, [role="button"]')) as HTMLElement[]) {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden" || el.closest("[hidden]") || el.closest("dialog:not([open])")) continue;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (rect.width < 44 || rect.height < 44) bad.push(`${el.id ? "#" + el.id : el.tagName.toLowerCase()} ${Math.round(rect.width)}x${Math.round(rect.height)}`);
    }
    return bad;
  });
  assert.deepEqual(problems, [], `${label}: inputs under 16px or tap targets under 44x44`);
}

test("public landing, chat and talk pass the mobile/tablet checks and link no admin page", { timeout: 120_000 }, async (t) => {
  const h = await publicHarness();
  const browser = await launch();
  if (!browser) { t.skip("Playwright Chromium is not installed"); await h.close(); return; }
  try {
    for (const viewport of VIEWPORTS) {
      const context = await browser.newContext({
        viewport: { width: viewport.width, height: viewport.height }, isMobile: viewport.width < 500, hasTouch: true, deviceScaleFactor: 2,
        extraHTTPHeaders: { "cf-connecting-ip": "203.0.113.7", "cf-ray": "8f00000000000000-LHR" },
      });
      for (const route of ["/", "/public/chat", "/public/talk"]) {
        const page = await context.newPage();
        await page.goto(h.base + route, { waitUntil: "networkidle" });
        await checkPage(page, `${route} @ ${viewport.name}`);
        const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll("a[href]")).map((a) => a.getAttribute("href")));
        for (const href of hrefs) {
          assert.ok(href === "/login" ? route === "/" : /^\/public\//.test(href ?? ""), `${route} links ${href}`);
        }
        await page.close();
      }
      // The chat face renders the owner's display name from config, and the ping dialog opens.
      const chat = await context.newPage();
      await chat.goto(h.base + "/public/chat", { waitUntil: "networkidle" });
      assert.match(await chat.textContent("#subtitle") ?? "", /Alex Example's chief of staff/);
      assert.equal(await chat.textContent("#pingButton"), "Ping Alex");
      await chat.click("#pingButton");
      assert.equal(await chat.isVisible("#pingDialog"), true);
      await checkPage(chat, `/public/chat ping dialog @ ${viewport.name}`);
      await chat.close();
      await context.close();
    }
  } finally {
    await browser.close();
    await h.close();
  }
});
