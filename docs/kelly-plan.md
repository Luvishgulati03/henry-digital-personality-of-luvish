# Kelly: electrical-shop quotation agent

Design and implementation plan, 12 September 2026. Status: proposed design; no Kelly runtime has been implemented or deployed. Prepared from Luvish's brief, inspection of Henry's current code, and the primary sources listed below.

## 1. Product decision

Kelly helps an electrical retailer turn one customer requirement list into accurate, comparable quotations across brands. The owner should enter the requirement once, resolve missing specifications once, and then change brand without rebuilding the basket.

The first release is an owner-operated assistant for one shop. It runs through terminal, web and the owner's Telegram bot. Customer voice conversations are a later, restricted interface to the same quotation services. Kelly retains Engram memory, a catalogue RAG system, reminders, workflow scheduling, and owner approvals. Career tools, job scouting, resume editing and social posting are absent from Kelly's enabled capabilities.

Henry gains the same catalogue and quotation capabilities as an optional module. Sharing code does not share customers, catalogues, memories, credentials or conversations. The shop receives a fresh Kelly installation, never a copy of Luvish's personal Henry state or proprietary GrowthX corpus.

The central design is **RAG for finding and explaining products; validated product records and deterministic code for selecting variants and calculating money**. Embedding a price-list PDF alone cannot establish which price belongs to which SKU, whether a figure is per piece or per pack, or whether a replacement is electrically suitable.

## 2. Scope and assumptions

Confirmed: the cousin sells electrical goods, receives brand-specific requests, uses catalogues and manual pricing, and repeats the work for alternative brands. Files will be supplied as PDFs. Kelly must have memory, scheduling, RAG and all three interfaces. Voice comes later.

Assumptions for planning, to validate against real documents:

- Start with one shop, one owner and at most a small number of staff.
- Start with two or three brands in one or two high-volume categories.
- The owner supplies the current commercial rules and approves imported prices.
- Catalogue presence does not prove stock availability.
- Prices may come from a separate price list, dealer sheet or owner override, not the product brochure.
- The first output is a quotation, not a tax invoice or accounting entry.
- English product specifications need Hindi/Hinglish aliases for conversational requests.
- First deployment uses one designated host. Phone and Telegram clients connect to that host; they do not maintain competing copies of the database.

Questions that materially change the implementation: actual categories and brands, price basis, discounts, pack units, GST registration and presentation, stock source, normal quote size, shop operating system, always-on host availability, number of staff and customer languages. These do not block this design, but they must be settled before pilot configuration.

## 3. The counter workflow

1. Owner starts a customer basket: “20 six-amp switches, 10 sixteen-amp sockets, five fan regulators; Brand A.”
2. Kelly retains the original wording and creates structured requirements with quantities and units.
3. Kelly asks only consequential questions: series, colour, modular versus non-modular, mounting and accessory requirements. Missing safety-critical attributes remain unresolved.
4. Kelly searches the active catalogue, offers identifiable SKU variants and shows the source page beside each uncertain choice.
5. Owner selects variants or confirms a proposed match. Kelly applies the shop's approved pricing policy and calculates the quotation.
6. Customer asks for Brand B. Kelly clones the same requirement basket into a new scenario, preserving quantities and specifications.
7. Kelly matches Brand B candidates and displays exact matches, qualified alternatives and unavailable lines separately. The owner resolves exceptions.
8. A comparison shows line-level differences, complete-basket totals, discount and tax treatment, availability status and required accessories.
9. Owner finalizes a version and downloads or prints a customer PDF. Electronic dispatch is a separate, approved operation.
10. Kelly remembers useful owner preferences and creates requested follow-up reminders. The quotation database retains the commercial record.

Example acceptance script: assemble Brand A, compare Brand B, change two quantities, remove one line, reopen the quote on Telegram, export it from the web interface, and recover the same version after restarting Kelly. All surfaces must display the same saved numbers.

## 4. Research and repository findings

### External evidence and its design implications

- Schneider Electric publishes dated price-list documents, and its India price-list search result explicitly notes incomplete price coverage. Treat catalogue versions and unknown prices as first-class data. The 2025 document is an example of source structure, not a current price authority. [Manufacturer document](https://www.se.com/in/en/download/document/fd_wdpricelist_2025/).
- Tesseract documents difficulties with tables and the need for segmentation and image-quality handling. OCR text alone is therefore insufficient for unattended price activation. [Tesseract guidance](https://tesseract-ocr.github.io/tessdoc/ImproveQuality.html).
- CBIC Rule 46 specifies tax-invoice particulars. Keep quotations and invoices distinct, and retain structured tax fields if invoicing is added later. Product GST rates are not established by this plan and must be configured from current, validated classifications. [CBIC rules](https://taxinformation.cbic.gov.in/content-page/explore-rules/1000136/1000001).
- SQLite provides an Online Backup API for consistent snapshots while a database is in use. Plan a restore-tested snapshot workflow rather than copying changing database files sequentially. [SQLite backup API](https://sqlite.org/backup.html).
- Telegram has document and voice message primitives, but transport limits and access depend on the API deployment. Check limits during implementation, stream downloads and provide web-upload fallback for oversized PDFs. [Telegram Bot API](https://core.telegram.org/bots/api).

The detailed domain model, matching rules, rollout and targets below are engineering proposals derived from these constraints and the shop brief, not manufacturer claims or measured results.

### Curated playbooks used

The discovery and pilot approach draws on GrowthX modules **Building the future with ChatGPT**, **Scope & growth**, and **How to build your own AI Agent**: validate a real workflow with real inputs, bound the initial scope and test the complete sequence before activation. These modules do not specify electrical equivalence, price extraction or tax arithmetic; those are separate design work in this plan. No proprietary playbook material should be copied into Kelly's customer deployment.

### Actual Henry implementation, not just the architecture document

| Area | What exists | What Kelly needs |
|---|---|---|
| Runtime | `src/runtime.ts` directly constructs Gmail, career and other services | Real capability allow-list, lazy construction and surface-level authorization |
| Memory | `src/memory/engram.ts`, Markdown sources and SQLite retrieval | Independent shop memory paths, owner/customer scopes, source-of-truth rules |
| Embeddings | `src/embeddings.ts`: local quantized BGE small, 384 dimensions, shared loader | Reuse first; benchmark catalogue abbreviations and multilingual requests |
| PDF import | `src/knowledge/importer.ts`: whole-document `pdftotext`, text chunks | Page/table/cell provenance, OCR fallback, product extraction and review |
| Retrieval | `src/knowledge/store.ts`: hybrid recall, source caps, domain boosts | Strict shop/brand/version/category filtering and exact SKU lookup |
| Surfaces | Terminal, dashboard/web, Telegram bridge and pump | Shared commerce command handlers and durable basket identity |
| Scheduling | Default workflows, file workflows, reminders and locking | Kelly-specific defaults; installed runner with heartbeat and missed-job policy |
| Global launcher | `bin/henry.mjs` loads source via tsx | Separate `kelly` launcher with installation-root resolution |
| Backup | Henry-specific mirror script | Kelly snapshot manifest, explicit destination and successful restore audit |

Important gaps: Henry's generic domain preference boosts results rather than enforcing a strict boundary; catalogue filtering must enforce boundaries before candidates can be selected. Its source-diversity cap can suppress multiple relevant items on one catalogue. Its importer copies by basename and lacks page-level extraction. Its embedding wrapper truncates input text, so long table chunks can lose specifications. These behaviors must not silently carry into commerce.

## 5. Architecture and shared-code strategy

Explicit requirement from Luvish: Kelly must have the same architecture as Henry. Kelly is a named, shop-configured instance of Henry's agent architecture, using the same core implementations. Do not build a second runtime, memory engine, orchestrator, scheduler or chat transport for Kelly.

Use one maintained TypeScript codebase with two executable profiles. Both launchers compose the shared runtime; Kelly changes identity, enabled modules, shop configuration and state paths. Make the smallest backward-compatible changes needed to support these profiles. Extract shared packages later only if distribution requires it, without changing the architecture.

| Henry architectural component | Kelly implementation |
|---|---|
| Runtime and configuration | Same composition root, with Kelly profile and isolated shop paths |
| Agent and Luna orchestration | Same request routing, specialist dispatch, resource limits and result handling; shop-specific specialist roles |
| Provider interface | Same Codex-primary / Claude-fallback abstraction and session machinery, independently configured credentials |
| Engram memory | Same capture, recall and consolidation mechanisms; fresh shop memory |
| Knowledge RAG | Same embedding provider and Engram-backed retrieval foundation; catalogue-specific ingestion and strict filter extensions |
| Scheduler and reminders | Same workflow engine, locking and ticker mechanisms; shop-specific jobs |
| Approval and activity | Same approval store, execution claim and activity reporting; quotation-specific action types |
| Terminal, web and Telegram | Same adapters and shared runtime entry points; Kelly branding and commerce commands |

The commerce database is a domain store inside an optional module, analogous to Henry's existing job tracker or standup stores. It complements the shared RAG and memory architecture. Catalogue table extraction, equivalent-product matching and quote calculation are new capabilities plugged into that architecture, available to Henry through the same module.

```text
Terminal                  Owner web                    Owner Telegram
    \                         |                             /
             Authenticated command / query interface
                              |
                 Shared Henry runtime + Kelly profile
                              |
     +------------------------+-------------------------+
     |                        |                         |
 Conversation service   Commerce services          Shared agent core
 Requirements parser    Product catalogue          Engram memory
 Clarification state    Price books                Provider runner
 Basket context         Brand matching             Scheduler / locks
                        Quote calculator           Approvals / activity
                        PDF rendering              Health / backup
     |                        |                         |
     +----------- Separate shop-scoped stores ----------+
                 PDF originals + page evidence
                 Catalogue retrieval index
                 Commerce SQLite database
                 Memory Markdown + Engram index
```

All interfaces call application services. No terminal-only business logic, Telegram-only quotation parser or web-only calculation. LLM outputs are schema-validated proposals; services enforce product eligibility, access, pricing and version checks.

Proposed module contract: capability ID, initialization/disposal, commands, routes, approval executors, workflow handlers, health checks and migration list. The runtime registers enabled modules; disabled modules contribute no prompts, routes, commands, timers or services. A requested unavailable tool returns an explicit unsupported-capability result.

Kelly profile: commerce, catalogue retrieval, memory, reminders, scheduler, activity, owner web and Telegram. Henry profile: retain current capabilities and allow optional commerce enablement. Existing Henry configuration and commands remain backward compatible.

Do not use Henry's `--dangerously-skip-permissions` provider execution context for a public customer interface. Future customer sessions need a constrained tool broker and separate execution identity with no shell, owner memory, credentials or arbitrary file access.

## 6. Persistent data model

| Record | Essential fields and purpose |
|---|---|
| Shop | ID, display name, locale, timezone, currency, address, owner IDs, tax configuration |
| Principal | Owner/staff/customer role, allowed shop, linked surface identities |
| CatalogueDocument | Hash, immutable original, brand, type, issue/effective dates, import status, parser version |
| Evidence | Document/page, printed page label, bounding box or table row, raw text, extraction method, confidence |
| ProductVariant | Brand, series, SKU, category, normalized attributes, colour, unit, pack size, status, evidence |
| PriceEntry | Product, price-book version, amount, currency, price basis, tax inclusion, unit basis, effective dates, reviewer |
| PricePolicy | Priority, scope, discount or markup rule, effective dates, owner authorization |
| StockAssertion | Product, quantity/status, source and checked-at time; unknown unless supplied |
| RequirementBasket | Customer/session, immutable original request, revision, requirements and unresolved fields |
| RequirementLine | Category, required attributes, quantity/unit, optional preferences and accessories |
| MatchDecision | Requirement, target SKU, satisfied constraints, differences, evidence, reviewer |
| QuoteVersion | Basket revision, scenario/brand, price-policy version, frozen lines, totals, validity, status |
| QuoteLine | Requirement ID, SKU, quantity, unit conversion, list/selling price, discount, tax, evidence IDs |
| Approval | Quote version/hash, artifact hash, action, recipient, approver, execution claim |
| ActivityEvent | Actor, surface, command, entity/version, outcome and timestamp |
| ImportJob | Checkpoints, parser/embedding versions, rejected rows and publication state |

Store monetary inputs in integer paise and percentage rates as fixed precision. Use exact decimal/rational arithmetic for intermediate operations and one explicit rounding policy. Store fractional quantity precision by unit; reject fractional pieces unless the product permits it. Distinguish metres, coils, boxes, packs and pieces throughout.

Products, commercial policies and quotes live in the commerce database. Memory may say “owner usually prefers white switches”; it cannot override a quote price or a confirmed SKU. Quote history does not decay when memories are consolidated.

## 7. PDF ingestion and catalogue RAG

### Pipeline

1. Receive a PDF through web upload, owner Telegram or CLI. Validate content signature, size/page limits and parser timeout. Identify shop and uploader.
2. Calculate a content hash and retain the original under a collision-safe document ID. Re-uploading identical bytes resumes or reports the existing import; it does not create duplicate products.
3. Ask for brand, document type, effective date and price basis when the document does not establish them. Separate brochure, technical datasheet and price list.
4. Extract per page. Preserve layout, table headers, cells, notes and page references. Detect image-only or low-quality pages and route them to local OCR. Add a vision extractor only for difficult layouts after cost/privacy evaluation.
5. Produce schema-validated candidate rows. Keep model output separate from approved product/price records. Attach evidence to each critical field.
6. Normalize SKU punctuation without destroying the raw code; normalize units, Indian number formatting, series names and aliases. Join cross-page headers and avoid mixing adjacent price columns.
7. Validate duplicate SKUs, missing units, impossible quantities, price shifts, tax ambiguity, column drift and pack-to-piece confusion. Extracted confidence is a review signal, not proof of correctness.
8. Show source page and candidate record side by side. Owner reviews prices and safety-critical attributes. Batch approval is available only for already validated homogeneous rows; uncertain rows stay quarantined.
9. Publish a version atomically. Until publication, no provisional row is quotable. An import with exceptions may publish an explicitly selected valid subset with a coverage report.
10. Create contextual chunks from product families and individual variants, retaining identifiers and relevant notes. Generate local embeddings and build the separate catalogue index. No strategy-card distillation for commercial facts.
11. Produce import report: pages processed, OCR pages, candidates, approved/rejected products, unresolved prices, index version and errors. Retain checkpoints for resumable imports.

### Retrieval path

Resolve explicit SKU/barcode via exact indexed lookup first. Otherwise normalize the request, apply category/brand/series/version constraints, retrieve with lexical and vector search, then rank only eligible candidates. Re-fetch the selected product and price from the structured store before building the quote.

Use the same local embedding approach as Henry initially. Do not inherit its numeric retrieval thresholds without calibration. Build Hindi/Hinglish aliases and a normalized English query while preserving the original. Benchmark this against a multilingual embedding option before changing models; store model IDs and support versioned reindexing.

Source links open the actual PDF page, not a guessed URL. Missing price produces “price needed”; missing product produces “no verified match.” New catalogues supersede active versions for new quotes, while old quotes retain their original version and price. Catalogue publication, price publication and index readiness must agree; expose a blocked/degraded state if they do not.

## 8. Cross-brand equivalence

Compare the customer's requirement to products in each brand. Do not translate Brand A's display name directly into Brand B's name.

Each category has a schema separating mandatory constraints from preferences. Examples to validate with the owner:

- Switch/socket: rated current/voltage, function, mounting format, module size, series/plate compatibility; colour is usually a preference.
- Circuit breaker: poles, rated current, trip curve, voltage and breaking capacity. A different curve or lower breaking capacity cannot be labelled equivalent.
- Cable: conductor material, cross-section, cores, insulation/fire classification and length unit. Never silently substitute conductor material or wire size.
- Lighting: wattage, lumen output, colour temperature, fitting, dimensions and required IP rating.
- Fans/appliances: product-specific capacity, dimensions, power requirements and features. Do not pretend one schema covers everything.

Results: **meets recorded requirements**, **alternative with explicit differences**, **needs clarification**, or **unavailable**. This is a product specification comparison, not autonomous electrical system design or certification.

Series ecosystems matter. A socket, plate, frame and box may be a compatible bundle rather than independently swappable parts. Derive accessories per scenario; do not retain Brand A plates around Brand B modules without a validated compatibility rule.

Owner-approved substitutions are stored with scope, evidence and catalogue version. Changes in specifications invalidate affected mappings. A correction improves future lookup through curated mappings and aliases; Kelly does not silently retrain or rewrite electrical requirements.

Compare complete baskets. If Brand B lacks one line, show partial subtotal and the missing item, and do not declare it cheaper than a complete Brand A quote. Keep mixed-brand alternatives separate and explicitly labelled.

## 9. Pricing, taxes and quotation versions

The owner configures the allowed pricing basis: MRP less discount, dealer rate plus markup, negotiated rate, or explicit override. Define precedence and detect overlapping policies. “20% margin” and “20% markup” are different operations; clarify ambiguous instructions.

Calculation stages: normalize quantity and pack units; resolve effective price; apply authorized line discounts; allocate any order discount using a documented rule; calculate taxable amounts and configured taxes; add applicable charges; apply the agreed rounding policy; save all components and policy versions.

Tax-inclusive prices must be decomposed rather than taxed twice. Never hardcode a universal GST percentage for electrical products. Capture the item's validated tax classification, business configuration and supply context before generating tax-labelled totals. Have the owner's accountant validate the presentation and rounding policy. A quotation clearly identifies itself as a quotation.

Synthetic arithmetic fixture only: 10 units at ₹100 pre-tax, 10% discount, hypothetical 18% tax gives ₹1,000 gross, ₹100 discount, ₹900 taxable, ₹162 tax and ₹1,062 total. This fixture is not a price or tax recommendation. Add reverse-tax, pack conversion, fractional metre and discount-allocation tests.

Quote states: draft → needs information or ready for review → finalized → optionally approved for delivery → delivered. Expired, superseded and cancelled are explicit states. Commercial acceptance is a separate recorded customer outcome, not implied by delivery.

Editing produces a new revision. Finalized PDF and JSON snapshot contain stable prices, quantity, source versions, validity and totals. Repricing produces a diff and a new version. An old quote must never change because a new catalogue was uploaded.

PDF contents: shop details, quote number/version/date, customer details if provided, SKU/description/quantity/unit, agreed discounts/tax presentation, totals, validity, delivery terms and availability caveats relevant to that quote. Internal cost, margin and private owner notes are omitted from customer output. Local download/print does not dispatch to a customer. Sending binds approval to exact recipient, version and artifact hash; editing invalidates that approval.

## 10. Three interfaces and global commands

The following commands are proposed interfaces, not currently installed commands:

```sh
kelly setup
kelly doctor
kelly repl
kelly web
kelly telegram status
kelly catalog import ./brand-a.pdf --brand "Brand A"
kelly catalog imports
kelly catalog review import_123
kelly catalog publish import_123
kelly catalog search "16A white modular socket"
kelly quote create --request "20 switches and 10 sockets"
kelly quote show Q-001
kelly quote compare Q-001 --brands "Brand A,Brand B"
kelly quote revise Q-001 --request "make the sockets 12"
kelly quote export Q-001 --format pdf
kelly memory search "preferred series"
kelly remind "Review expired price list" --in 2h
kelly schedule status
kelly schedule install
kelly backup status
henry commerce quote show Q-001 --shop demo-shop
```

Kelly's launcher resolves code from its installation and state from the selected shop profile, independent of shell working directory. Global installation must not overwrite `henry`. Proposed `KELLY_ROOT` and profile selection must ignore inherited Henry paths and tokens by default. Test from unrelated directories and with both agents installed. Recommend a packaged build for shop installation with a documented Node version and native-module support; use the existing tsx launcher during development only if packaging remains reliable.

Web is the main counter workspace: basket/editor, catalogue review with source page, brand comparison, quote history, owner approval queue and operational health. Progressive disclosure keeps everyday quoting simple. Tablet-width layout and keyboard-friendly quantity editing matter more than decorative chat animation.

Telegram supports owner requests, document upload, basket selection, compact comparisons and owner preview documents. Link the owner by explicit setup identity; never let an arbitrary Telegram user become the shop owner. One update pump per bot, durable deduplication and message-to-basket mapping. The owner can reopen the same quote from any surface. Do not merge unrelated chats into one implicit “latest quote.”

Terminal offers the same operations plus structured output for diagnostics. Typed command schemas should generate help and drive both web API validation and Telegram actions. Use optimistic revision checks and per-quote transactions to prevent staff edits from overwriting one another.

## 11. Memory and scheduling

Kelly memory captures owner preferences, terminology, confirmed customer requirements and recurring follow-ups. Scope customer memories by customer/session permissions; anonymous customers receive temporary session context. Do not carry one customer's budget or project into another customer's conversation. Owners can inspect and correct remembered facts.

Use separate stores for memory, catalogue knowledge and business transactions. Memory consolidation can supersede preferences, but cannot archive products, revise a finalized quote or remove a transaction. Rebuild Engram from Markdown and catalogue vectors from approved documents/records in a restore test.

Default proposed jobs: catalogue/price freshness reminders; owner-requested quote follow-ups; import resumption; scheduled memory consolidation; local snapshot backup once configured; health checks. No inherited job scouting, social posting, standup or personal-email workflows.

The scheduler must run on a designated host through an installed service, with last heartbeat, last/next run, failure and missed-run state visible in `doctor` and web. Define different catch-up rules: coalesce missed digest reminders; resume imports; never automatically send overdue customer messages. Use per-job idempotency keys and a single scheduler owner across all surfaces.

No automatic source/cache/backup deletion under Luvish's deletion preference. Show disk usage and suggested targets for explicit review. Backups should be consistent database snapshots plus immutable files and a manifest; test restoring to a new directory without modifying the live shop. An external destination and retention policy require shop-owner configuration. Do not inherit Luvish's private GitHub backup destination.

## 12. Voice phase

Keep the interaction contract transport-neutral now: text/transcript → requirement proposal → clarification → owner-reviewed quotation. Later add speech-to-text and text-to-speech adapters without changing commerce calculations.

Phase V1: owner sends Telegram voice notes; show transcript and extracted items before applying edits. Phase V2: microphone in the owner web app. Phase V3: customer conversation in a separate restricted session, with handoff to staff for missing facts and final commercial decisions.

Test Indian English, Hindi and Hinglish, noisy shops, brand pronunciation, “sixteen” versus “sixty,” quantity corrections and units. Read back critical quantities/specifications and show them visually. Voice confidence never authorizes a discount, changes owner settings or substitutes a safety-critical part.

Customer tools may search approved retail information and prepare their own basket. They cannot access cost price, margins, other customers, owner memory, arbitrary files, provider shells or approval controls. Recording, retention and provider choices need explicit shop configuration. Do not promise offline speech or free inference until the chosen hardware and models are benchmarked.

## 13. Deployment and cost

Use one shop PC or small host with persistent storage and backups. Terminal works on the host; the web UI can be made available through authenticated LAN access; remote access needs a deliberately configured secure route. Telegram requires internet and a running host. Confirm Windows versus macOS/Linux before choosing the service installer; Henry's current launchd path is not a Windows deployment solution.

Local catalogue embeddings reuse Henry's approach, but first-time model downloads, OCR, language-model inference, hosting and later voice still have real resource or subscription costs. Quote calculations, saved-quote browsing and lexical SKU search should work when the language provider is unavailable. Offer a manual basket editor during provider outages. Semantic search is available offline only after its model is installed.

Avoid per-request ingestion or re-embedding; cache by source hash and model version. Budget one substantial background extraction task at a time on a low-memory machine and prioritize active counter quotation requests. Benchmark the actual shop hardware rather than transferring M1 timing claims.

## 14. Implementation sequence and deliverables

| Phase | Deliverable | Exit evidence |
|---|---|---|
| 0. Observe and label | 10 representative historical baskets; 2–3 brand PDFs; pricing/units worksheet; owner-approved expected matches | Same requirement can be described without a brand SKU; gaps are explicit |
| 1. Isolate core | Agent profiles, module registration, independent roots, Kelly launcher and diagnostics | Kelly starts on terminal/web/Telegram; career services absent; Henry regression suite passes |
| 2. Ingest | Immutable PDFs, page extraction, structured records, review/publish, isolated catalogue RAG | Real PDFs yield cited approved products; no provisional prices enter quotes |
| 3. Quote | Basket service, versioned pricing policies, deterministic calculator and PDF | Known baskets reproduce owner's expected totals; revisions do not mutate history |
| 4. Compare | Category constraints, accessories, curated equivalence and comparison UI | Brand changes preserve requirements and expose missing/different items |
| 5. Integrate | Cross-surface basket continuity, scheduler service, owner roles, backup/restore | End-to-end audit and fresh-install restore succeed |
| 6. Pilot | Shadow quoting alongside cousin, correction queue, timing/error measures | Owner accepts accuracy and workflow speed on real counter tasks |
| 7. Voice | Owner voice first, then restricted customer sessions | Noisy-language evaluation and transcript-confirmation flows pass |

Time planning: a narrow owner-reviewed text pilot is plausibly 4–6 engineering weeks after usable sample catalogues arrive. Complex OCR, Windows packaging or broad categories can extend it substantially. This is a planning estimate, not a delivery commitment. Estimate again after Phase 0 and the first import benchmark. Voice is a separate estimate.

Proposed implementation paths: `src/commerce/` for domain/services/calculation; `src/catalogue/` for parsing/review/indexing; `src/agent-profiles/` for Henry/Kelly compositions; `bin/kelly.mjs`; shared surface adapters; isolated tests under `tests/commerce/`, `tests/catalogue/`, `tests/kelly/`. Prefer incremental extraction from existing runtime with compatibility tests rather than moving every file at once.

Each phase should land as a reviewable change with migrations, rollback behavior and acceptance evidence. No new dependency, port or service is considered integrated until `kelly doctor` can report its readiness. Preserve Henry data and take validated snapshots before migrations; never use real shop state as test fixtures.

## 15. Audit and release gates

| Area | Required tests and evidence |
|---|---|
| Extraction | Selectable/scanned/mixed PDFs, merged cells, multipage tables, missing headers, decimal OCR errors, identical names/different content, repeated import |
| Data quality | Every quotable SKU/price has source evidence and accepted version; unknown price never becomes zero |
| Retrieval | Exact-SKU hits; strict shop/brand/category/version filtering; out-of-catalogue abstention; Hindi/Hinglish alias cases; no cross-shop memory |
| Matching | No silent downgrade of mandatory attributes; incompatible accessories excluded; no complete-total claim for a partial basket |
| Money | Integer/decimal properties, inclusive/exclusive tax, discount precedence, sequential discounts, markup versus margin, pack conversion, allocation and rounding |
| Quote lifecycle | Immutable finalized snapshots, stale approval rejection, correct source/price version, expiry and explicit repricing |
| Interface parity | Same basket and totals via terminal/web/Telegram; upload and callback authorization; concurrent edit conflict |
| Isolation | Kelly does not instantiate career/social/Gmail tools; Henry optional module disabled has no behavior change; separate roots and credentials |
| Architecture parity | Both profiles use the same runtime, Engram adapter, provider runner, Luna orchestration, scheduler, approval machinery and three surface adapters; no duplicated Kelly core |
| Scheduling | Installed service, reboot recovery, sleeping host, missed run, duplicate ticker, owner notifications and no unapproved customer delivery |
| Failures | Model timeout, malformed extraction, interrupted import, full disk, missing embedding cache, unavailable browser/PDF engine |
| Backup | Snapshot integrity, original files and policy versions, SHA manifest, recovery onto empty test root, rollback without deleting live data |
| Customer voice | Restricted tools, private-price protection, session isolation, noisy quantities/units and handoff |

Baseline targets for pilot selection, not current performance claims: 100% arithmetic agreement on gold fixtures; zero unsafe automatic substitutions or uncited prices; exact SKU retrieval success on all active gold-catalogue cases; at least 95% eligible-candidate recall@5 on the labelled ambiguous-query set, paired with precision and abstention reporting. Owner-approved imported prices are required irrespective of aggregate extraction accuracy.

Measure median and p95 time from request to owner-approved complete quote, owner edits per basket, clarification count, SKU/price/unit error rates, brand-switch time, failed imports and counter abandonment. Seek at least a 50% reduction against the cousin's measured manual baseline during the pilot; this is a hypothesis to test. A short benchmark must not be reported as production reliability.

Integration audit is planned here, not claimed complete. Henry's previously reported 597 passing tests are historical baseline evidence only; rerun them on the implementation branch. Review six passes: logic, safety/permissions, product workflow, query performance, consistency, and rendered surface behavior.

## 16. Design review conclusions and next inputs

This plan addresses the main failure modes found during review: plain RAG cannot safely price a table; a brand switch can invalidate accessories; missing lines can make partial quotes look cheaper; memory can become a stale price source; a disabled service can still start through runtime construction; Telegram and web can overwrite the same basket; configured jobs can remain inactive without an installed runner; backups can appear successful without a restore test.

Next inputs are the first brand PDFs, an anonymized completed quotation and the owner's pricing rules. These let implementation begin with a labelled vertical slice instead of guessing the shop's commercial behavior. The first demonstrable milestone is one saved basket producing two complete, traceable brand quotations through all three interfaces.

## 17. Approved addition: Excel navigation and editing

Luvish approved the architecture and requested Excel support on 2026-09-12. Include this in the implementation, not as a separate general-purpose agent. Both Kelly and Henry's optional commerce module must call the same workbook service through their existing tool registry and terminal, web and Telegram adapters.

### Shop workflows

- Inspect a workbook, list its sheets, navigate a named sheet or cell range, search SKU/brand/description, filter rows and explain a selected price or formula using its source cells.
- Import supplier price lists from XLSX and CSV alongside PDF catalogues. Preview column mappings for SKU, brand, specification, unit, pack size, price, tax basis and effective date. Preserve SKUs as text, including leading zeros.
- Change explicitly selected prices, quantities or descriptions; add quotation rows and extend compatible formulas. Preview the cell-level changes before application. Broad natural-language requests must resolve to explicit ranges before editing.
- Export a customer quotation and a brand comparison as XLSX with clear inputs, formula-driven totals and rupee number formats. Internal purchase prices and margins must never enter customer exports, including hidden sheets, comments or workbook metadata.
- Feed reviewed supplier rows into the versioned structured catalogue and its RAG evidence, not directly into live prices. Source evidence includes original file hash, sheet, cell range and accepted import version.

### Safety and correctness

Original files remain unchanged by default. Save a new version, record a change manifest and reject stale edits if the source hash has changed. Overwriting an original requires explicit permission for that exact file. Never delete originals or execute workbook macros. Do not refresh external links, fetch remote workbook references or evaluate imported content as instructions. Reject unsupported encrypted, macro-enabled or legacy formats with a clear conversion request instead of silently damaging them.

Preserve existing formulas, number formats, sheet order, merged regions and supported workbook features. Run a compatibility check before saving; if a feature cannot round-trip safely, block the edit and explain it. Do not promise universal preservation. Distinguish formula text from cached results: stale or unsupported calculations cannot supply a quotable price. Quote arithmetic remains authoritative in the deterministic money service; reconcile exported formula results against it before release. Guard text exports against formula injection while retaining deliberately authored formulas.

Workbook uploads use the same owner authentication, size limits, path restrictions, audit trail and separate shop storage as catalogue uploads. Remember preferences in Engram, but keep prices and workbook versions in business storage. PDF and spreadsheet evidence share product provenance while retaining their original location types.

### Proposed interface and implementation contract

Add a shared `src/commerce/workbooks/` service with inspect, range-read, search, preview-edit, save-version, import-preview and quotation-export operations. Proposed global commands are `kelly sheets inspect`, `kelly sheets read`, `kelly sheets search`, `kelly sheets edit` and `kelly sheets export`; exact argument syntax will be documented with the implemented CLI. Web and Telegram must use these same handlers rather than independently interpreting edits.

Here, navigation means navigating workbook sheets, ranges and records. Controlling a running Microsoft Excel desktop window is a separate integration, not implied by file support. Do not require an assistant-host-only artifact runtime for Kelly's standalone installation; select and verify a redistributable workbook adapter during implementation and report its supported feature matrix.

### Release checks

Test multi-sheet imports, leading-zero SKUs, Indian currency display, blanks versus zero prices, formula and formatting preservation, merged cells, formula injection, unsupported features, stale source conflicts, source-file immutability and customer-export privacy. Verify the same edit preview and resulting version across all three interfaces. Reopen saved XLSX files, inspect key cells/formulas and visually review representative quotation exports. Use only synthetic workbooks in the public repository. Add readiness reporting to `kelly doctor`; do not label Excel support complete until these checks pass.
