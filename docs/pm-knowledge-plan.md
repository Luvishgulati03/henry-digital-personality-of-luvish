# PM mastery corpus — plan (DO NOT BUILD until Luvish says go)

Status: planned 2026-08-09. Explicitly gated: Luvish will say when to build.

## Goal

Henry becomes a top-tier project management professional: PMP-grade frameworks
(predictive + agile), risk, stakeholders, estimation, earned value — indexed into
the knowledge layer with the same rigor as the strategy corpus, cited by module
name in answers, and applied in his own behavior (standup summaries, launch crews,
goal planning).

## Sourcing the books — the honest part

PMP books are copyrighted; I won't fetch pirated copies. Two clean lanes:

1. **Luvish shares PDFs he owns** (he offered): PMBOK Guide (7th ed), Rita
   Mulcahy's *PMP Exam Prep*, and/or Andy Crowe's *The PMP Exam* are the strongest
   trio. Drop them in `~/Downloads/pm-books/`. They stay in `knowledge/` (gitignored
   from the public repo; private mirror only) — personal-use RAG over owned copies.
2. **Legitimately open books I can fetch myself** to round out coverage: Adrienne
   Watt's *Project Management* (CC-licensed open textbook), *Project Management for
   Instructional Designers* (CC), NASA/GAO public-domain PM handbooks.

Best plan: his owned PMP trio + 1-2 open books for breadth.

## Pipeline (when green-lit)

1. **PDF → markdown**: add `pdf-parse` (small pure-JS dep) + `scripts/pdf-to-md.mjs`
   — chapter/heading-aware extraction, one md per chapter with metadata headers
   (`book`, `edition`, `chapter`, `pages`). Books are NOT course modules: chunking
   must follow the book's own structure, ~500-800 token chunks with overlap.
2. **Domain**: new `project-management` domain — add to the domain router
   (detectKnowledgeDomain) + `knowledge add` allowed domains + three-lane routing
   provenance note ("PMBOK-derived = framework-speak; adapt ceremony weight to
   startup reality — Luvish runs lean teams, not construction megaprojects").
3. **Index**: `knowledge add knowledge/raw/pm-books --domain project-management`
   — local bge-small embeddings, $0, sequential on the M1 Air (~30-60 min for
   ~1,500 pages; admission-controlled, machine stays usable).
4. **Eval before/after**: add 15-20 PM eval queries (critical path, float, risk
   response strategies, stakeholder power/interest grid, EVM: SPI/CPI/EAC,
   predictive-vs-agile tailoring, change control). The 3×-corpus MRR-dip lesson
   applies — measure, don't assume.
5. **Distill selectively**: ~100-200 strategy cards via the existing nightly
   knowledge-distill batches (capped provider spend; plain indexing alone is free
   and already useful).
6. **Behavior, not just recall**: capability line ("PM questions ground in the
   project-management playbook lane, cite book+chapter"), plus
   `skills/project-management/SKILL.md` — how Henry RUNS a project when asked
   (charter → WBS → risk register → comms plan → EVM check-ins), grounded in the
   corpus. Standup evening summaries borrow delivered-vs-planned discipline
   explicitly (they already judge against the morning plan).
7. **Verify live**: EVM math questions, risk-response taxonomy, a full mini
   project plan — answers must cite the indexed chapters.

## Cost

Indexing $0 (local embeddings). Distillation = bounded provider calls in nightly
batches. No new services.

## What Luvish does at go-time

Drop the owned PDFs in `~/Downloads/pm-books/` and say "build the PM corpus".
