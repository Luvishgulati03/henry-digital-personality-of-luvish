/**
 * engram — a plug-and-play associative memory layer for any AI agent.
 *
 * Public API surface. Import what you need:
 *   import { Engram } from "engram-memory";
 */
export { Engram } from "./engram.js";
// Storage
export { SqliteStore, toFtsQuery } from "./store/sqlite-store.js";
// Embeddings (pluggable)
export { createEmbeddingProvider, } from "./embeddings/provider.js";
export { HashingEmbeddingProvider } from "./embeddings/hashing.js";
export { OpenAIEmbeddingProvider } from "./embeddings/openai.js";
// Ingestion
export { ingestDirectory, ingestFile, walk, chunkContent, } from "./ingest/markdown.js";
// Graph (Phase 2 — associative edges)
export { buildEdges, } from "./graph/build.js";
export { extractEntities } from "./graph/entities.js";
export { tagMemories, parseTags } from "./enrich/tagging.js";
export { EMOTIONS, EMOTION_FAMILIES, emotionInfo, emotionValence, isKnownEmotion, emotionPalettePrompt, affectFromMetadata, } from "./enrich/emotions.js";
export { buildLlmEdges, parseRelations, } from "./graph/llm-edges.js";
// Evaluation + weight tuning — Phase 4
export { evaluate, tuneWeights, } from "./eval/recall-eval.js";
// Consolidation ("dreaming") — Phase 3
export { consolidate, reinforce, readmit, salience, DEFAULT_SALIENCE, } from "./consolidation/consolidate.js";
export { promote, promotionScore, DEFAULT_PROMOTION, } from "./consolidation/promote.js";
// Retrieval
export { recall, DEFAULT_WEIGHTS } from "./retrieval/hybrid.js";
export { llmRerank, parseOrder } from "./retrieval/rerank.js";
export { spreadActivation, } from "./retrieval/spreading.js";
// LLM (subscription CLIs — claude/codex — or any custom command)
export { createLLMProvider, } from "./llm/provider.js";
export { ClaudeCliProvider } from "./llm/claude-cli.js";
export { CodexCliProvider } from "./llm/codex-cli.js";
export { CommandProvider } from "./llm/command.js";
// Config
export { loadConfig } from "./config.js";
// Dashboard — the live neuron-graph visualiser (out of the box)
export { startDashboard } from "./dashboard/server.js";
export { DASHBOARD_HTML } from "./dashboard/page.js";
// Utils that callers may reuse
export { cosine, l2normalize } from "./util/cosine.js";
export { parseFrontmatter } from "./util/frontmatter.js";
export { runCommand, runViaTmux } from "./util/exec.js";
//# sourceMappingURL=index.js.map