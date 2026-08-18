# Build your agent's PM brain — book → knowledge layer, agent-executable

This guide turns a project-management book (or ANY book you own) into indexed,
retrievable knowledge inside this agent — the same pipeline the strategy corpus
uses — and switches on PM MODE so the agent *acts* on it. It is written for an
**agentic coding assistant** (Claude Code, Codex CLI, or similar) running inside a
bootstrapped clone of this repo: paste the fenced block below to it, or follow the
steps by hand. Every step ends with a verification — do not continue past a failed
check.

**Copyright rule (non-negotiable):** only ingest books the operator actually owns.
The extracted text lands in `knowledge/`, which is **gitignored** — book content
must never be committed or pushed to a public repository. Verify at the end.

---

## Paste this into your agent

```
You are ingesting an owned book PDF into this repo's knowledge layer, then
enabling PM mode. Work through the steps in order; each has a verification —
stop and report if one fails. Do not commit anything under knowledge/.

STEP 0 — Preconditions
- Repo is bootstrapped (BOOTSTRAP.md done): `npx tsc --noEmit` is clean.
- Ask the operator for the PDF path of a book they OWN, a short slug
  (e.g. pmbok-7), and the book's title.
- `npm ls pdf-parse || npm install pdf-parse@1.1.1`

STEP 1 — Extract PDF → section markdown
Run:  node scripts/pm-extract.mjs "<pdf path>" <slug> "<book title>"
Verify: it prints "parsed N pages" and "wrote M section files to
knowledge/raw/pm-books/<slug>" with M roughly N/6..N/4. Spot-open one file:
it must have a `# <title> — <section>` heading and a `> book: ...` metadata
line, followed by readable prose (not glyph soup — if it IS soup, the PDF is
scanned/image-based; OCR is out of scope, report to the operator).

STEP 2 — Domain check (skip if using project-management)
The domain "project-management" already exists. For a DIFFERENT domain:
(a) add it to KNOWLEDGE_DOMAINS in src/knowledge/store.ts;
(b) add a keyword regex line in src/knowledge/router.ts — place it BEFORE any
    broader pattern that would swallow it (e.g. project-management sits before
    product-management, because /product/ matches both);
(c) update the domain list in the `knowledge add` usage string in src/cli.ts.
Verify: `npx tsc --noEmit` clean.

STEP 3 — Index (local embeddings, free, no API)
Run:  npx tsx src/cli.ts knowledge add knowledge/raw/pm-books/<slug> \
        --name <slug> --domain project-management
Verify: the printed report shows files == M from step 1, chunks > files,
skipped: [], and byDomain has ALL chunks under your one domain. A mixed
byDomain means the explicit --domain flag didn't apply — stop.

STEP 4 — Retrieval proof
Run:  npx tsx src/cli.ts knowledge search "<a topic the book definitely
      covers>" --domain project-management
Verify: results cite sources like imported/<slug>/NNN-<section>.md and the
content excerpts are actually about the topic. Try one more query from a
different chapter.

STEP 5 — Eval hygiene (recommended)
Add 10-15 domain queries to data/eval/queries.json (mirror the existing
shape), then run: npx tsx src/cli.ts knowledge eval
Verify: precision@5 for the new domain queries is > 0.4; if far lower, your
section files are probably too coarse — re-extract with smaller
MAX_PAGES_PER_FILE in scripts/pm-extract.mjs and re-run step 3.

STEP 6 — Optional strategy cards (spends provider calls)
npx tsx src/cli.ts knowledge add <same path> --name <slug> \
  --domain project-management --distill
Only with the operator's explicit OK — plain indexing is already useful.

STEP 7 — Switch on PM MODE
Run:  npx tsx src/cli.ts pm on     (repl: ":pm on" or "project manager mode")
This makes the project-management lane the DEFAULT retrieval domain and
activates the operating contract: PMBOK-cited judgments; every decision as
DECISION / WHY / RISKS & MITIGATION / OWNER + DUE; delivered-vs-planned
update processing; assignment drafts gated on operator approval; durable
decision log via memory.
Verify: npx tsx src/cli.ts pm status → "PM mode: ON", then ask the agent one
planning question and confirm the reply cites book sections and renders the
decision contract.

STEP 8 — Privacy verification (do not skip)
Run:  git check-ignore knowledge && git status --porcelain | grep -c knowledge
Verify: check-ignore prints "knowledge" (it IS ignored) and the grep finds 0
tracked knowledge files. Book text must never reach a public remote.
```

---

## How it works (for the humans reading along)

- `scripts/pm-extract.mjs` does coarse, heading-aware PDF→markdown (PMBOK-style
  numbered headings and ALL-CAPS titles become section boundaries); the knowledge
  importer then does fine token-level chunking, so every stored chunk carries
  book + section + pages provenance.
- Indexing uses the same local embedding model as everything else in this repo —
  no API cost, works offline, ~a minute per hundred pages on an M1 Air.
- The retrieval brain labels corpus coverage per query (strong/partial/none) and
  the agent cites sections instead of vaguely "per PMBOK".
- PM MODE is a persisted toggle (settings.json) that changes the agent's operating
  contract, not just its knowledge — see the PM MODE block in src/agent/henry.ts.

Related guides: [BOOTSTRAP.md](BOOTSTRAP.md) (stand up your own fork),
[build-your-own-knowledge-rag.md](build-your-own-knowledge-rag.md) (build a
course/notes corpus from scratch), docs/pm-knowledge-plan.md (the design this
implements).
