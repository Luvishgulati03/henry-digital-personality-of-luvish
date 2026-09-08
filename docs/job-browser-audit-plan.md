# Browser application audit and acceptance plan

## Scope

Henry must generate answers and operate the browser itself. A supervising agent reviews source grounding, observed fields, upload evidence, and status reporting. UI-only: no job submission API or MCP substitute. Filling and final submission are distinct actions; approval to test filling is not approval to submit unknown content.

## Phase 1 — accurate preparation and filling

- Allow a per-application source resume, including PDF, without replacing the operator's default profile.
- Extract rendered job text, excluding script/style payloads.
- Discover required fields, textareas, native selects, ARIA comboboxes, and uploads accurately.
- Match controls by stable identity, not ambiguous labels such as "Attach".
- Upload only to a positively identified resume control; never guess that a sole upload is a resume field.
- Generate candidate claims only from supplied source/profile facts. Unknown referral source, ambiguous experience totals, and voluntary sensitive disclosures remain unanswered.
- Report filled and skipped fields and capture browser evidence. Do not equate partial filling with a complete application.

Acceptance: isolated fixture tests followed by an explicitly authorized live fill, no submit click, and independent review of Henry's actual generated answers and screenshot.

## LinkedIn — excluded

Current implementation: optional scout search/navigation exists; service and browser explicitly block filling/submission; LinkedIn preparation deliberately creates no submission approval. This is policy, not a missing browser installation. Job-preference editing and multi-step Easy Apply are not demonstrated by generic form filling.

The operator explicitly excluded LinkedIn applying. Preserve the existing rail. Operate on a job URL the operator provides, never infer authorization to hunt or bulk apply. Never import session cookies into prompts/logs or bypass login, CAPTCHA, account restrictions, or identity checks. Do not claim LinkedIn support from a Greenhouse test.

Account-risk reference: [LinkedIn prohibited software](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions?lang=en), checked 2026-09-08. LinkedIn prohibits third-party automation; capability does not imply platform permission or freedom from account restrictions.

## Phase 3 — reliable final submission (required before enabling)

- Bind approval to destination, exact answer set, and resume bytes; invalidate on change.
- Block missing required facts, unresolved placeholders, failed uploads, and duplicate applications.
- Atomically claim execution across processes, not only within one object.
- Validate the live destination and review state before clicking.
- Require positive confirmation evidence; timeout after a click means uncertain outcome, not success or a safe automatic retry.

Acceptance: tests for changed payload/PDF, missing fields, upload failure, duplicate/racing claims, validation rejection, CAPTCHA, navigation-only buttons, confirmation, and ambiguous post-click outcome. Existing passing unit tests alone do not establish these properties.

## Privacy and evidence

Store real applications, source files, screenshots, provider output, and operator decisions only in ignored local data/memory. Commit framework changes and synthetic tests only. Record the exact commands/tests actually run; distinguish implemented, fixture-tested, live-tested, and pending.

## Manager-controlled specialist workflow

Following [OpenAI's orchestration guidance](https://developers.openai.com/api/docs/guides/agents/orchestration), Henry retains ownership and invokes bounded specialists rather than handing execution authority to them. This implements the pattern using Henry's existing subscription CLI runner, not the API-backed Agents SDK. No new metered service is required.

- Coordinator: Codex `gpt-5.6-sol`, medium for ordinary work.
- `resume-tailor`: `gpt-5.5`, medium; technical recruiter/editor generating grounded answers.
- `application-review`: `gpt-5.5`, medium; independent hiring reviewer checking evidence and suitability. GPT-5.4 was requested and remains configurable, but a live Codex CLI probe on 2026-09-08 returned that it is unsupported with this ChatGPT account. The verified subscription-compatible default is therefore 5.5, not a hidden runtime fallback.
- Two sequential read-only calls per preparation; no recursive dispatch, no automatic rewrite loop, no shared conversation session across applications. Browser operations remain code-controlled.
- Character budgets reject oversized evidence rather than truncating facts. Specialist timeouts bound each call. Existing admission control manages machine pressure.
- The reviewer verdict is not human approval. It authorizes neither upload nor submission. The service binds reviewed content and attachment hashes and rejects changed or legacy unreviewed drafts before filling/submitting.

### Usage

`henry jobs prepare <job-url> --resume /absolute/path/to/resume.pdf`

The PDF is extracted for evidence and retained byte-for-byte as the attachment. This preserves its exact format, but does not constitute content tailoring of that PDF. Exact-format content edits require a matching editable source/template and visual verification; do not silently use the generic Markdown renderer instead. Existing Markdown-source flows still use their established renderer.

After reviewing the generated answers and granting permission to fill:

`henry jobs fill <application-id>`

Missing personal facts remain blank; optional demographics are not blockers. Filling currently captures evidence and closes its browser context. Multi-page Next/Review navigation and resumable manual corrections need dedicated adapters/tests; this release must not claim all sites work.
