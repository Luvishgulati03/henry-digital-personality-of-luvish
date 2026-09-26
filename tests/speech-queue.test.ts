import test from "node:test";
import assert from "node:assert/strict";
import { SpeechCancelled, SpeechQueue, SpeechQueueFull } from "../src/voice/speech-queue.ts";
import { FIRST_CHUNK, speechChunks, splitFirstClause } from "../src/voice/speakable.ts";

/** A fake engine: records call order and the most calls it ever saw running at once. */
function engine(delayMs = 5) {
  const calls: string[] = [];
  let active = 0;
  const state = { maxActive: 0, fail: new Set<string>() };
  const synthesize = async (text: string): Promise<Buffer> => {
    active += 1;
    state.maxActive = Math.max(state.maxActive, active);
    calls.push(text);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
    active -= 1;
    if (state.fail.has(text)) throw new Error(`engine failed on ${text}`);
    return Buffer.from(text);
  };
  return { calls, state, synthesize };
}

test("speech queue: one synthesis at a time, FIFO per requester, round-robin across requesters", async () => {
  const e = engine();
  const queue = new SpeechQueue(e.synthesize);
  const done = await Promise.all([
    queue.run("a", "a1"), queue.run("a", "a2"), queue.run("a", "a3"),
    queue.run("b", "b1"), queue.run("b", "b2"),
    queue.run("owner", "o1"),
  ]);
  assert.deepEqual(done.map(String), ["a1", "a2", "a3", "b1", "b2", "o1"]);
  assert.equal(e.state.maxActive, 1, "never two syntheses at once");
  // a1 was already running when the rest arrived; then b and the owner get turns between a's sentences.
  assert.deepEqual(e.calls, ["a1", "a2", "b1", "o1", "a3", "b2"]);
});

test("speech queue: over a cap the job is refused at once, never dropped later", async () => {
  const e = engine();
  const queue = new SpeechQueue(e.synthesize, { maxPendingPerOwner: 2, maxPending: 3 });
  const first = queue.run("a", "running"); // starts at once: not pending
  const kept = [queue.run("a", "a1"), queue.run("a", "a2")];
  await assert.rejects(queue.run("a", "a3"), SpeechQueueFull);
  kept.push(queue.run("b", "b1"));
  await assert.rejects(queue.run("c", "c1"), SpeechQueueFull, "the overall cap");
  assert.deepEqual((await Promise.all([first, ...kept])).map(String), ["running", "a1", "a2", "b1"]);
  assert.equal(queue.size(), 0);
});

test("speech queue: cancel(owner) and an aborted signal drop waiting jobs; the running one finishes", async () => {
  const e = engine(10);
  const queue = new SpeechQueue(e.synthesize);
  const running = queue.run("a", "a1");
  const waiting = queue.run("a", "a2");
  const controller = new AbortController();
  const aborted = queue.run("b", "b1", { signal: controller.signal });
  const other = queue.run("b", "b2");
  controller.abort();
  await assert.rejects(aborted, SpeechCancelled);
  assert.equal(queue.cancel("a"), 1);
  await assert.rejects(waiting, SpeechCancelled);
  assert.equal(String(await running), "a1");
  assert.equal(String(await other), "b2");
  assert.deepEqual(e.calls, ["a1", "b2"]);
  await assert.rejects(queue.run("a", "x", { signal: AbortSignal.abort() }), SpeechCancelled);
});

test("speech queue cache: a prefetch is joined, not repeated; failures and expired entries are retried", async () => {
  const e = engine();
  let clock = 1_000;
  const queue = new SpeechQueue(e.synthesize, { ttlMs: 500, now: () => clock });
  const prefetch = queue.cached("v:s1:0", "v", "Hello there.");
  assert.ok(queue.peek("v:s1:0"), "in flight counts as cached");
  const joined = queue.cached("v:s1:0", "v", "Hello there.");
  assert.equal(joined, prefetch);
  assert.equal(String(await joined), "Hello there.");
  assert.equal(String(await queue.cached("v:s1:0", "v", "Hello there.")), "Hello there.");
  assert.deepEqual(e.calls, ["Hello there."], "synthesised once");
  clock += 501;
  assert.equal(queue.peek("v:s1:0"), undefined, "expired after the TTL");
  e.state.fail.add("Broken.");
  await assert.rejects(queue.cached("v:s2:0", "v", "Broken."));
  assert.equal(queue.peek("v:s2:0"), undefined, "a failure is not cached");
  e.state.fail.clear();
  assert.equal(String(await queue.cached("v:s2:0", "v", "Broken.")), "Broken.");
  // cancel forgets the requester's cached audio too
  await queue.cached("v:s3:0", "v", "Kept?");
  queue.cancel("v");
  assert.equal(queue.peek("v:s3:0"), undefined);
});

test("speech queue cache: holds at most maxCachedBytes of finished audio, oldest out first", async () => {
  const queue = new SpeechQueue(async (text) => Buffer.alloc(text.length), { maxCachedBytes: 10 });
  await queue.cached("k1", "v", "123456");
  await queue.cached("k2", "v", "1234");
  assert.ok(queue.peek("k1") && queue.peek("k2"));
  await queue.cached("k3", "v", "12345");
  assert.equal(queue.peek("k1"), undefined);
  assert.ok(queue.peek("k2") && queue.peek("k3"));
});

test("speechChunks: sentences, and a long first sentence split once at a clause of about 60-120 chars", () => {
  const long = "Alex Example is a product manager who builds AI tools for small businesses, and he has spent the last few years shipping voice and chat assistants.";
  const [head, tail] = splitFirstClause(long);
  assert.equal(head, "Alex Example is a product manager who builds AI tools for small businesses,");
  assert.equal(tail, "and he has spent the last few years shipping voice and chat assistants.");
  assert.ok(head.length >= FIRST_CHUNK.min && head.length <= FIRST_CHUNK.max);

  const text = `${long} His recent work includes a shop assistant, a voice ordering flow, and more. Ask away!`;
  assert.deepEqual(speechChunks(text), [long, "His recent work includes a shop assistant, a voice ordering flow, and more.", "Ask away!"]);
  assert.deepEqual(speechChunks(text, { firstChunk: true }), [head, tail, "His recent work includes a shop assistant, a voice ordering flow, and more.", "Ask away!"], "only the first sentence is split");

  // Short sentences stay whole; so does a long one with no clause boundary.
  assert.deepEqual(splitFirstClause("Short and sweet, really."), ["Short and sweet, really."]);
  const noBoundary = "a".repeat(80) + " " + "b".repeat(80) + ".";
  assert.deepEqual(splitFirstClause(noBoundary), [noBoundary]);
  // A dash: the head ends before it.
  const dashed = "He spent six years building products for merchants across India and abroad — mostly voice and chat assistants for small neighbourhood shops.";
  assert.deepEqual(splitFirstClause(dashed), ["He spent six years building products for merchants across India and abroad", "mostly voice and chat assistants for small neighbourhood shops."]);
  // The latest boundary within 60-120 wins over an earlier one.
  const two = "First part is here, then a second clause keeps going for a while, and then the rest of the sentence carries on to the end.";
  assert.equal(splitFirstClause(two)[0], "First part is here, then a second clause keeps going for a while,");
  assert.deepEqual(speechChunks("   "), []);
});
