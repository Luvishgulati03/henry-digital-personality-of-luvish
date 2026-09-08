#!/usr/bin/env node
import { Engram } from "./engram.js";
import { loadConfig } from "./config.js";
import { emotionPalette, emotionFamilyLegend } from "./enrich/emotions.js";
import type { EmbeddingConfig } from "./embeddings/provider.js";
import type { LLMConfig } from "./llm/provider.js";

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        flags[key] = true;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const HELP = `engram — plug-and-play associative memory for any agent

USAGE
  engram <command> [options]

COMMANDS
  index <dir>          Index a directory of .md/.txt files into the memory store
  recall <query...>    Retrieve the most relevant memories for a query
  add <text...>        Add a single memory
  graph                Export the associative graph (nodes + edges) as JSON
  tag <text>           Tag a memory (tier/importance/emotion/topic/people) as JSON
  dream                Nightly maintenance: promote proven memories, then consolidate
  promote              Promote proven memories short-term -> long-term (durable tier)
  eval <file.json>     Score recall@k against a labelled set ([{query,relevantIds}])
  dashboard            Serve the live neuron-graph visualiser (recall, dream, explore)
  stats                Show index statistics
  help                 Show this help

COMMON OPTIONS
  --db <path>          SQLite file (default: $ENGRAM_DB or ./engram.db)
  --config <path>      Load settings from a JSON config (default: ./engram.config.json)
  --provider <name>    Embedding provider: hashing (default, offline) | openai
  --model <name>       Embedding model (openai), e.g. text-embedding-3-small
  --dim <n>            Embedding dimensions
  --openai-key <key>   OpenAI API key (or set OPENAI_API_KEY)

LLM OPTIONS (use your subscription — no API key)
  --llm <name>         claude | codex | none   (powers --rerank)
  --llm-model <name>   Model: claude e.g. sonnet|opus|haiku; codex e.g. gpt-5-codex
  --tmux               Invoke the LLM CLI via a silent tmux session

index OPTIONS
  --chunk <mode>       auto (default) | file | paragraph | heading
  --fresh              Wipe the index before indexing (clean rebuild)
  --incremental        Only embed new/changed content (skip unchanged chunks)
  --no-graph           Skip building the associative graph (edges)
  --llm-edges          After indexing, derive caused/supersedes/lesson_from
                       edges with the configured LLM (needs --llm)

recall OPTIONS
  -k <n>               Number of results (default: 8)
  --tier <tier>        Restrict to a tier (episodic|semantic|procedural|...)
  --associative        Spread activation across the graph — surface related
                       memories that share no words/vectors with the query
  --hops <n>           Spreading hops in associative mode (default: 2)
  --decay <f>          Per-hop attenuation 0..1 in associative mode (default: 0.5)
  --trace              With --json, include the activation trace (seeds +
                       per-node activation + provenance) — for visualisation
  --rerank             Rerank candidates with the configured LLM (better recall)
  --mark-used          Bump recency/use counters on returned memories
  --reinforce          Hebbian: strengthen edges among the co-retrieved results
  --json               Output raw JSON

dream OPTIONS
  --capacity <n>       Max hot memories to keep; lowest-salience archived beyond it
  --min-uses <n>       Min recall count for promotion eligibility (default: 3)
  --no-promote         Skip the promotion (short-term -> long-term) pass
  --no-consolidate     Skip the consolidation (forget) pass
  --json               Output raw JSON

dashboard OPTIONS
  --port <n>           Port to serve on (default: 7755)
  --host <addr>        Host/interface to bind (default: 127.0.0.1)

promote OPTIONS
  --min-uses <n>       Min recall count to be eligible (default: 3)
  --limit <n>          Max memories to promote this pass (highest-scoring first)
  --to-tier <tier>     Durable tier to promote into (default: semantic)
  --dry-run            Rank candidates without promoting anything
  --json               Output raw JSON

EXAMPLES
  engram index ./memories
  engram recall "what went wrong with the last deploy?" -k 5
  engram recall "trust an agent that says it's done?" --llm claude --llm-model sonnet --rerank
  engram add "Prod broke when we skipped the migration step" --tier episodic --importance 9
  engram promote --dry-run        # see which episodic memories have earned long-term status
  engram stats
`;

/** Build an embedding config from flags, or undefined to fall back to config/default. */
function embeddingFromFlags(flags: Record<string, string | boolean>): EmbeddingConfig | undefined {
  if (!flags.provider && !flags.dim) return undefined;
  const provider = (flags.provider as string) || "hashing";
  const dim = flags.dim ? Number(flags.dim) : undefined;
  if (provider === "openai") {
    return {
      provider: "openai",
      apiKey: (flags["openai-key"] as string) || process.env.OPENAI_API_KEY,
      model: (flags.model as string) || undefined,
      dim,
    };
  }
  return { provider: "hashing", dim };
}

/** Build an LLM config from flags, or undefined to fall back to config/none. */
function llmFromFlags(flags: Record<string, string | boolean>): LLMConfig | undefined {
  const llm = flags.llm as string | undefined;
  if (!llm) return undefined;
  if (llm === "none") return { provider: "none" };
  const model = (flags["llm-model"] as string) || undefined;
  const useTmux = Boolean(flags.tmux);
  if (llm === "claude" || llm === "claude-cli") return { provider: "claude-cli", model, useTmux };
  if (llm === "codex" || llm === "codex-cli") return { provider: "codex-cli", model, useTmux };
  return undefined;
}

async function main(): Promise<void> {
  const { positionals, flags } = parseArgs(process.argv.slice(2));
  const cmd = positionals[0];

  if (!cmd || cmd === "help" || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  const config = loadConfig(flags.config as string | undefined);
  const dbPath = (flags.db as string) || config.dbPath || process.env.ENGRAM_DB || "engram.db";
  const engram = new Engram({
    dbPath,
    embedding: embeddingFromFlags(flags) ?? config.embedding,
    llm: llmFromFlags(flags) ?? config.llm,
  });

  try {
    switch (cmd) {
      case "index": {
        const dir = positionals[1];
        if (!dir) throw new Error("index requires a <dir> argument");
        const res = await engram.indexDirectory(dir, {
          chunk: (flags.chunk as never) || "auto",
          fresh: Boolean(flags.fresh),
          incremental: Boolean(flags.incremental),
          edges: flags["no-graph"] ? false : undefined,
        });
        process.stdout.write(
          `Indexed ${res.memories} memories from ${res.files} files ` +
            `in ${res.directory} (${res.durationMs}ms, pruned ${res.pruned}, skipped ${res.skipped} unchanged, model ${res.embeddingModel}).\n` +
            (flags["no-graph"] ? "" : `Associative graph: ${engram.stats().edges} edges.\n`),
        );
        if (flags["llm-edges"]) {
          if (!engram.llm) {
            process.stderr.write("Note: --llm-edges needs an LLM; pass --llm claude (or codex).\n");
          } else {
            process.stdout.write("Deriving semantic edges with the LLM…\n");
            const le = await engram.buildLlmEdges();
            process.stdout.write(
              `LLM edges: caused ${le.caused}, supersedes ${le.supersedes}, lesson_from ${le.lesson_from} ` +
                `(from ${le.pairsConsidered} pairs, ${le.calls} calls).\n`,
            );
          }
        }
        break;
      }

      case "recall": {
        const query = positionals.slice(1).join(" ");
        if (!query) throw new Error('recall requires a query, e.g. recall "how do I X"');
        const rerank = flags.rerank !== undefined ? Boolean(flags.rerank) : Boolean(config.rerank);
        if (rerank && !engram.llm) {
          process.stderr.write("Note: --rerank requested but no LLM configured; using hybrid order.\n");
        }
        const trace = Boolean(flags.trace);
        const associative = Boolean(flags.associative) || trace;
        const spread = associative
          ? {
              hops: flags.hops ? Number(flags.hops) : undefined,
              decay: flags.decay ? Number(flags.decay) : undefined,
            }
          : undefined;
        const recallOpts = {
          k: flags.k ? Number(flags.k) : undefined,
          tier: (flags.tier as string) || undefined,
          markUsed: Boolean(flags["mark-used"]),
          reinforce: Boolean(flags.reinforce),
          rerank,
          associative,
          spread,
        };

        // --trace: emit results + the full activation trace (for the dashboard).
        if (trace) {
          const out = await engram.recallTrace(query, recallOpts);
          process.stdout.write(`${JSON.stringify(out, null, flags.json ? 2 : 0)}\n`);
          break;
        }

        const results = await engram.recall(query, recallOpts);
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(results, null, 2)}\n`);
          break;
        }
        if (results.length === 0) {
          process.stdout.write("No memories found.\n");
          break;
        }
        process.stdout.write(`\nTop ${results.length} memories for: "${query}"\n\n`);
        results.forEach((r, i) => {
          const snippet = r.content.replace(/\s+/g, " ").slice(0, 240);
          process.stdout.write(
            `${i + 1}. [score ${r.score.toFixed(4)}] ${snippet}\n` +
              `   ↳ ${r.why}${r.source ? ` · ${r.source}` : ""}\n\n`,
          );
        });
        break;
      }

      case "add": {
        const text = positionals.slice(1).join(" ");
        if (!text) throw new Error("add requires text");
        const id = await engram.add({
          content: text,
          source: (flags.source as string) || null,
          tier: (flags.tier as string) || null,
          importance: flags.importance ? Number(flags.importance) : undefined,
        });
        process.stdout.write(flags.json ? `${JSON.stringify({ id })}\n` : `Added memory ${id}\n`);
        break;
      }

      case "tag": {
        // Texts come from a positional arg, or a JSON array of strings on stdin
        // (for batch tagging). Emits a JSON array of MemoryTags (order preserved).
        let texts: string[];
        const positional = positionals.slice(1).join(" ").trim();
        if (positional) {
          texts = [positional];
        } else if (!process.stdin.isTTY) {
          const chunks: Buffer[] = [];
          for await (const c of process.stdin) chunks.push(c as Buffer);
          const stdin = Buffer.concat(chunks).toString("utf-8").trim();
          try {
            const parsed = JSON.parse(stdin || "[]");
            texts = Array.isArray(parsed) ? parsed.map(String) : [String(parsed)];
          } catch {
            texts = stdin ? [stdin] : [];
          }
        } else {
          texts = [];
        }
        const tags = await engram.tagMemories(texts);
        process.stdout.write(`${JSON.stringify(tags)}\n`);
        // Whole-batch LLM failure means these are neutral fallbacks, not
        // judgments. Exit non-zero so gating callers (which would silently
        // drop the fallback's low scores) switch to persist-everything.
        if (tags.length > 0 && tags.every((t) => t.llmFailed)) {
          process.stderr.write("tag: LLM unavailable — emitted neutral fallback tags\n");
          process.exitCode = 2;
        }
        break;
      }

      case "graph": {
        const g = engram.graphExport();
        // Bundle the emotion palette + family legend so any dashboard consuming
        // this JSON (engram's own, or an embedding app's) colours neurons identically.
        const out = { ...g, palette: emotionPalette(), families: emotionFamilyLegend() };
        // Default to compact JSON (this feeds the dashboard); --pretty for humans.
        process.stdout.write(`${JSON.stringify(out, null, flags.pretty ? 2 : 0)}\n`);
        break;
      }

      case "dream": {
        // Full nightly cycle: promote proven memories (short-term -> long-term),
        // then consolidate (archive low-salience). --no-promote / --no-consolidate
        // run just one half; --capacity caps the hot set during consolidation.
        const capacity = flags.capacity ? Number(flags.capacity) : undefined;
        const res = engram.dream({
          promote: flags["no-promote"] ? false : { minUseCount: flags["min-uses"] ? Number(flags["min-uses"]) : undefined },
          consolidate: flags["no-consolidate"] ? false : { capacity },
        });
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(res)}\n`);
          break;
        }
        const p = res.promotion;
        const c = res.consolidation;
        if (p) process.stdout.write(`Promoted ${p.promoted} short-term -> long-term (${p.eligible} eligible of ${p.scanned}).\n`);
        if (c) process.stdout.write(`Consolidated: scored ${c.scored}, kept ${c.kept}, archived ${c.archived} (${c.protectedCount} protected).\n`);
        break;
      }

      case "promote": {
        const dry = Boolean(flags["dry-run"]);
        const res = engram.promote({
          minUseCount: flags["min-uses"] ? Number(flags["min-uses"]) : undefined,
          limit: flags.limit ? Number(flags.limit) : undefined,
          toTier: (flags["to-tier"] as string) || undefined,
          dryRun: dry,
        });
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(res)}\n`);
          break;
        }
        process.stdout.write(
          `Promotion: scanned ${res.scanned}, ${res.eligible} eligible, ` +
            `${dry ? `would promote ${res.eligible}` : `promoted ${res.promoted}`}.\n`,
        );
        const shown = dry ? res.candidates : res.candidates.slice(0, res.promoted);
        for (const c of shown) {
          process.stdout.write(`  [${c.score.toFixed(2)}] ${c.useCount}× recalled · ${c.label}\n`);
        }
        break;
      }

      case "eval": {
        const file = positionals[1];
        if (!file) throw new Error("eval requires a <file.json> labelled set");
        const { readFileSync } = await import("node:fs");
        const set = JSON.parse(readFileSync(file, "utf-8")) as Array<{ query: string; relevantIds: string[] }>;
        const { evaluate, tuneWeights } = await import("./eval/recall-eval.js");
        const k = flags.k ? Number(flags.k) : 8;
        const associative = Boolean(flags.associative);
        if (flags.tune) {
          const t = await tuneWeights(
            engram, set,
            { semantic: [0.5, 1, 2], lexical: [0.5, 1, 2], importance: [0, 0.5, 1] },
            { k, recall: { associative } },
          );
          process.stdout.write(
            `Tuned recall@${k}: ${t.baseline.toFixed(3)} → ${t.bestScore.toFixed(3)} ` +
              `with weights ${JSON.stringify(t.best)} (${t.trials.length} trials).\n`,
          );
        } else {
          const m = await evaluate(engram, set, { k, recall: { associative } });
          process.stdout.write(
            flags.json
              ? `${JSON.stringify(m, null, 2)}\n`
              : `Eval (${m.queries} queries, k=${k}): recall@k ${m.recallAtK.toFixed(3)}, ` +
                `MRR ${m.mrr.toFixed(3)}, hit@1 ${m.hitAt1.toFixed(3)}.\n`,
          );
        }
        break;
      }

      case "stats": {
        const s = engram.stats();
        process.stdout.write(`${JSON.stringify(s, null, 2)}\n`);
        break;
      }

      case "dashboard": {
        const port = flags.port ? Number(flags.port) : 7755;
        const host = (flags.host as string) || "127.0.0.1";
        const { startDashboard } = await import("./dashboard/server.js");
        startDashboard(engram, { port, host });
        const s = engram.stats();
        process.stdout.write(
          `\n  🧠  engram dashboard → http://${host}:${port}\n` +
            `      ${s.count} neurons · ${s.edges} synapses · ${s.entities} entities\n` +
            `      recall a memory and watch the neurons fire · Ctrl+C to stop\n\n`,
        );
        await new Promise<never>(() => {}); // serve until interrupted (skips the finally close)
        break;
      }

      default:
        process.stderr.write(`Unknown command: ${cmd}\n\n${HELP}`);
        process.exitCode = 1;
    }
  } finally {
    engram.close();
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
