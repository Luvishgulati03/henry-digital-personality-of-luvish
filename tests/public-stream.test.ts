import test from "node:test";
import assert from "node:assert/strict";
import { PublicReplyStream, sentenceEnd, sentencePieces, type StreamOutput } from "../src/public/stream.ts";
import { guardPublicReply } from "../src/public/guard.ts";
import { publicStreamEvent } from "../src/public/turn.ts";
import type { ProviderEvent } from "../src/types.ts";

/**
 * Streamed public replies are released a sentence at a time, and only after everything sent so
 * far plus the new sentence passes the output guard. See src/public/stream.ts.
 */

const OWNER = "Alex Example";

function collect(): { outputs: StreamOutput[]; stream: PublicReplyStream; text: () => string } {
  const outputs: StreamOutput[] = [];
  const stream = new PublicReplyStream(OWNER, ["secret-token-value-123"], (output) => outputs.push(output));
  const text = (): string => {
    let shown = "";
    for (const output of outputs) shown = output.type === "reset" ? "" : shown + output.text;
    return shown;
  };
  return { outputs, stream, text };
}

function feed(stream: PublicReplyStream, text: string, size = 3): void {
  for (let index = 0; index < text.length; index += size) stream.push(text.slice(index, index + size));
}

test("sentenceEnd: a boundary needs what follows; numbers, initials, and abbreviations are not boundaries", () => {
  assert.equal(sentenceEnd("Alex builds products"), -1);
  assert.equal(sentenceEnd("Alex builds products."), -1, "the full stop might be a decimal point");
  assert.equal(sentenceEnd("Alex builds products. He"), "Alex builds products. ".length);
  assert.equal(sentenceEnd("Really? Yes"), "Really? ".length);
  assert.equal(sentenceEnd("Version 3.5 shipped. Then"), "Version 3.5 shipped. ".length);
  assert.equal(sentenceEnd("See e.g. the dashboards. Then"), "See e.g. the dashboards. ".length);
  assert.equal(sentenceEnd("1. First item"), -1);
  assert.equal(sentenceEnd("Line one\nLine two"), "Line one\n".length);
  assert.deepEqual(sentencePieces("One. Two! Three"), ["One. ", "Two! ", "Three"]);
});

test("stream: sentences go out as they complete; the tail waits for the final reply", () => {
  const { outputs, stream, text } = collect();
  const reply = "Alex Example builds products. Mostly analytics dashboards! Ask me more";
  feed(stream, reply);
  assert.deepEqual(outputs.map((output) => output.type === "sentence" ? output.text : "reset"), ["Alex Example builds products. ", "Mostly analytics dashboards! "]);
  const finish = stream.finish(guardPublicReply(reply, OWNER));
  assert.deepEqual(finish, { action: "append", pieces: ["Ask me more"] });
  assert.equal(text() + (finish.action === "append" ? finish.pieces.join("") : ""), reply);
});

test("stream: a secret straddling a sentence break never goes out, and the reply is replaced", () => {
  const { stream, text } = collect();
  // "Bearer\n<token>": the first line alone is harmless, the cumulative check catches the rest.
  const reply = "Sure, here it is. Use Bearer\nabcdefghijklmnopqrstuvwxyz0123456789 to log in. Anything else?";
  feed(stream, reply, 5);
  assert.equal(text(), "Sure, here it is. Use Bearer\n");
  assert.ok(!text().includes("abcdefghij"));
  assert.ok(stream.tripped);
  assert.equal(stream.tripReason, "bearer");
  const final = guardPublicReply(reply, OWNER);
  assert.equal(final.ok, false);
  assert.deepEqual(stream.finish(final), { action: "replace", text: final.text });
});

test("stream: a local path in the first sentence sends nothing; the refusal then goes out as the reply", () => {
  const { outputs, stream } = collect();
  const reply = "The file is at /Users/someone/.env on the Mac. Want more?";
  feed(stream, reply);
  assert.equal(outputs.length, 0);
  const final = guardPublicReply(reply, OWNER);
  const finish = stream.finish(final);
  assert.equal(finish.action, "append", "nothing was shown, so the refusal simply streams");
  assert.match(finish.action === "append" ? finish.pieces.join("") : "", /can't share that/);
});

test("stream: a configured secret value trips the guard mid-stream", () => {
  const { stream, text } = collect();
  feed(stream, "Happy to help. The value is secret-token-value-123 right there. Bye now.");
  assert.equal(text(), "Happy to help. ");
  assert.equal(stream.tripReason, "configured secret");
});

test("stream: a usage-limit notice is held, not streamed, and the final reply decides", () => {
  const { outputs, stream } = collect();
  feed(stream, "You've hit your usage limit. Resets at 3pm. ");
  assert.equal(outputs.length, 0);
  assert.equal(stream.tripped, false, "held, not tripped: no guard violation");
});

test("stream: a new provider attempt resets what the earlier one streamed", () => {
  const { outputs, stream, text } = collect();
  stream.start();
  feed(stream, "First attempt sentence. More");
  assert.equal(text(), "First attempt sentence. ");
  stream.start();
  assert.equal(outputs.at(-1)?.type, "reset");
  feed(stream, "Second attempt. Done");
  assert.equal(text(), "Second attempt. ");
  const finish = stream.finish(guardPublicReply("Second attempt. Done", OWNER));
  assert.deepEqual(finish, { action: "append", pieces: ["Done"] });
});

test("stream: a final reply that differs from what streamed replaces it", () => {
  const { stream } = collect();
  feed(stream, "Commentary first. ");
  assert.deepEqual(stream.finish(guardPublicReply("The real answer.", OWNER)), { action: "replace", text: "The real answer." });
});

test("stream: halt (a sandbox violation) withdraws everything and ignores what follows", () => {
  const { outputs, stream, text } = collect();
  feed(stream, "Let me check that. ");
  stream.halt("claude attempted a tool call on a public turn");
  assert.equal(outputs.at(-1)?.type, "reset");
  feed(stream, "Here is the file. ");
  stream.start();
  assert.equal(text(), "");
});

test("publicStreamEvent: Claude text deltas and Codex agent messages are text; init/thread start an attempt; the rest is ignored", () => {
  const event = (parsed: Record<string, unknown>, stream: ProviderEvent["stream"] = "stdout"): ProviderEvent => ({ timestamp: "", stream, text: "", parsed });
  assert.deepEqual(publicStreamEvent(event({ type: "system", subtype: "init" })), { kind: "start" });
  assert.deepEqual(publicStreamEvent(event({ type: "thread.started", thread_id: "t" })), { kind: "start" });
  assert.deepEqual(publicStreamEvent(event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Hi" } } })), { kind: "text", text: "Hi" });
  assert.equal(publicStreamEvent(event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } })), undefined);
  assert.equal(publicStreamEvent(event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "input_json_delta", partial_json: "{}" } } })), undefined);
  assert.equal(publicStreamEvent(event({ type: "assistant", message: { content: [{ type: "text", text: "whole" }] } })), undefined, "the whole message would duplicate the deltas");
  assert.deepEqual(publicStreamEvent(event({ type: "item.completed", item: { type: "agent_message", text: "Codex says hi." } })), { kind: "text", text: "Codex says hi." });
  assert.equal(publicStreamEvent(event({ type: "item.completed", item: { type: "reasoning", text: "secret thoughts" } })), undefined);
  assert.equal(publicStreamEvent(event({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "x" } } }, "stderr")), undefined);
});
