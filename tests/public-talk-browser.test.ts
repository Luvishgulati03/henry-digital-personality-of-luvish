import test from "node:test";
import assert from "node:assert/strict";
import { chromium, type Browser, type Page } from "playwright";
import { publicHarness } from "./public-harness.ts";

/**
 * The public talk face in headless Chromium against the REAL public surface (fake provider runner
 * and fake voice engine), through the owner's local /public/talk preview. Silero's bundle is blocked so the page runs
 * its energy VAD, and `HenryTalk.testing.levelOverride` plays the microphone.
 */

async function launch(): Promise<Browser | undefined> {
  try {
    return await chromium.launch({ headless: true, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  } catch { return undefined; }
}

const waitState = (page: Page, text: string) => page.waitForFunction((t) => document.querySelector("#state")?.textContent === t, text, { timeout: 15_000 });

test("public talk: greeting is the public opening line, a spoken turn runs sandboxed, and the reply is spoken by id", { timeout: 120_000 }, async (t) => {
  const h = await publicHarness();
  const browser = await launch();
  if (!browser) { await h.close(); t.skip("Playwright Chromium is not installed"); return; }
  const errors: string[] = [];
  try {
    // The owner's local preview of the public face (a browser always sends its real Origin, and
    // through the tunnel only the exact public https origin is accepted: tests/public-mode.test.ts).
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.route("**/vendor/vad/**", (route) => route.abort());
    const speakBodies: string[] = [];
    page.on("request", (request) => { if (request.url().endsWith("/api/public/voice/speak")) speakBodies.push(request.postData() ?? ""); });
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${h.base}/public/talk`);
    await page.waitForFunction(() => (window as unknown as { HenryTalk?: { testing: { voiceStatus: unknown } } }).HenryTalk?.testing.voiceStatus != null);
    assert.equal(await page.locator("#state").textContent(), "Tap to talk");
    assert.equal(await page.locator("#pingLink").textContent(), "Ping Alex");

    await page.getByRole("button", { name: "Tap to talk", exact: true }).click();
    await waitState(page, "Listening");
    assert.equal(h.tts[0], "Hi, I'm Henry, Alex Example's chief of staff and AI twin. Ask me anything about Alex Example's work.");

    await page.evaluate(() => { const t = (window as any).HenryTalk.testing; t.speechMs = 50; t.silenceMs = 5000; t.levelOverride = 0.9; });
    await page.waitForTimeout(300);
    await page.evaluate(() => { const t = (window as any).HenryTalk.testing; t.silenceMs = 100; t.levelOverride = 0; });
    await waitState(page, "Speaking");
    await waitState(page, "Listening");

    assert.equal(h.stt.length, 1, "one upload to the public transcriber");
    assert.equal(h.runs.length, 1);
    assert.ok(h.runs[0].options.publicTurn, "the spoken turn ran in the public sandbox");
    assert.match(h.runs[0].prompt, /<visitor_message>\nWhat does Alex Example build\?/);
    assert.equal(speakBodies.length, 1);
    const spoken = JSON.parse(speakBodies[0]);
    assert.deepEqual(Object.keys(spoken), ["replyId"], "the page asks for a reply by id, never arbitrary text");
    assert.ok(h.tts.includes("Alex Example builds products."));
    assert.equal(await page.locator("#heard").textContent(), "What does Alex Example build?");
    assert.equal(await page.locator("#reply").textContent(), "Alex Example builds products.");
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    await h.close();
  }
});
