/**
 * Memory tagging — structured + emotional metadata for each memory.
 *
 * A raw captured exchange is just text. To store it the way a brain does, we
 * tag it: what KIND of memory is it (episodic event vs semantic fact vs
 * procedural how-to — the structure/tier), how IMPORTANT is it, what EMOTION
 * does it carry and how strongly, what's it ABOUT, and WHO is involved. Those
 * tags drive the short/long-term split, salience-based consolidation, and
 * affect-aware recall.
 *
 * Tagging uses the configured LLM (the user's subscription CLI). Without an LLM,
 * a safe heuristic fallback keeps everything working (episodic, neutral).
 */
import { emotionPalettePrompt } from "./emotions.js";
import { extractJsonArray } from "../util/json.js";
const FALLBACK = {
    tier: "episodic", importance: 0.5, emotion: "neutral",
    emotionIntensity: 0, topic: "", people: [], summary: "",
};
function clampUnit(n) {
    const x = typeof n === "number" ? n : Number(n);
    if (!Number.isFinite(x))
        return 0.5;
    return Math.min(1, Math.max(0, x > 1 ? x / 10 : x));
}
const VALID_TIERS = new Set(["episodic", "semantic", "procedural", "working"]);
function coerce(o, fallbackSummary) {
    const tier = String(o.tier ?? "").toLowerCase();
    const people = Array.isArray(o.people)
        ? o.people.filter((p) => typeof p === "string").map((p) => p.replace(/^@/, "").toLowerCase())
        : [];
    return {
        tier: (VALID_TIERS.has(tier) ? tier : "episodic"),
        importance: clampUnit(o.importance),
        emotion: typeof o.emotion === "string" && o.emotion ? o.emotion.toLowerCase() : "neutral",
        emotionIntensity: clampUnit(o.emotionIntensity),
        topic: typeof o.topic === "string" ? o.topic.slice(0, 60) : "",
        people,
        summary: typeof o.summary === "string" && o.summary ? o.summary : fallbackSummary,
    };
}
/** Extract the first JSON array from an LLM reply (balanced-bracket scan). */
export function parseTags(resp) {
    const arr = extractJsonArray(resp);
    if (!arr)
        return [];
    return arr.filter((o) => o && typeof o === "object");
}
function buildPrompt(texts) {
    const items = texts.map((t, i) => `[${i + 1}] ${t.replace(/\s+/g, " ").slice(0, 700)}`).join("\n");
    return (`You tag memories for an AI agent's memory system. For each numbered item, classify:\n` +
        `- "tier": episodic (a specific event/conversation), semantic (a durable fact/rule/preference), or procedural (a how-to/process)\n` +
        `- "importance": 0.0-1.0 — worth remembering long-term? (consequence, reusability, surprise). Calibrate: work that shipped or changed state (a fix delivered, a PR opened/merged, a deploy, a report with evidence) and decisions/commitments/requirement-changes are 0.6+; plans and in-progress work 0.5-0.6; greetings, acks, and status chatter 0.3 or less\n` +
        `- "emotion": the single lowercase emotion that best fits the tone. Pick the most precise one from this palette (or the closest word if truly none fit):\n${emotionPalettePrompt()}\n` +
        `- "emotionIntensity": 0.0-1.0\n` +
        `- "topic": 1-3 word label\n` +
        `- "people": array of names/handles mentioned (lowercase, no @; [] if none)\n` +
        `- "summary": one concise sentence\n\n` +
        `Items:\n${items}\n\n` +
        `Reply with ONLY a JSON array, one object per item, in order. No prose.`);
}
/**
 * Tag a batch of memory texts. Returns one MemoryTags per input (order
 * preserved). Falls back to neutral/episodic for any item on LLM failure or a
 * short/empty reply — tagging never blocks capture.
 */
export async function tagMemories(llm, texts) {
    if (texts.length === 0)
        return [];
    const fallback = (t) => ({
        ...FALLBACK,
        summary: t.replace(/\s+/g, " ").slice(0, 120),
        llmFailed: true,
    });
    if (!llm)
        return texts.map(fallback);
    let resp;
    try {
        resp = await llm.complete(buildPrompt(texts));
    }
    catch {
        return texts.map(fallback);
    }
    const parsed = parseTags(resp);
    return texts.map((t, i) => parsed[i] ? coerce(parsed[i], t.replace(/\s+/g, " ").slice(0, 120)) : fallback(t));
}
//# sourceMappingURL=tagging.js.map