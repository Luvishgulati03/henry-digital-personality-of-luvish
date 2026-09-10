# Job index reliability and cost plan

## Current contract

The job index is an evidence ledger, not a claim about every application a user
has ever submitted. It combines confirmed local browser submissions and
application-lifecycle email evidence. Digests are local and provider-free.

## Phase 1 — stop data loss and false notifications

- Reject limited, failed, empty, or malformed classifier runs without advancing
  the mailbox cursor.
- Serialize mailbox checks and tracker writes across processes.
- Persist important alerts in an outbox before delivery and retry until the
  notifier acknowledges them.
- Record a pre-click `submitting` fence so an irreversible browser submission
  can never become automatically retryable after a local write failure.
- Reconcile submitted local application records into the tracker without a
  provider call.
- Send one change-only digest after the scan window; suppress zero-change pings.
- Describe counts as indexed evidence, not total applications.

Status: implemented and covered by regression tests.

## Phase 2 — remove the model from mailbox retrieval

1. Fetch message IDs, headers, timestamps, and bodies through Henry's existing
   Gmail OAuth client.
2. Apply deterministic filters for known application confirmations,
   recommendation blasts, rejections, and duplicate messages.
3. Send only ambiguous candidate messages to one batched low-cost classifier.
4. Require a closed JSON schema and retain the mailbox cursor on any invalid
   batch.
5. Record provider-call count, candidate count, classified count, duration, and
   failure category without logging message bodies.

Target: empty or deterministic mailbox windows use zero model calls; ambiguous
windows use at most one t0 call.

## Phase 3 — make application identity and dates authoritative

- Prefer a stable local application ID or employer requisition ID.
- Carry Gmail message ID for lifecycle-event deduplication.
- Store `occurredAt` separately from `ingestedAt` and bucket reports in an
  explicitly configured timezone.
- Add an explicit `mark applied` command for applications completed manually or
  without a confirmation email.
- Surface data coverage and last successful scan alongside every report.

## Phase 4 — controlled repair

After Phase 2 passes fixtures and a test mailbox:

1. Snapshot the current tracker and mailwatch state.
2. Re-scan from the last trustworthy cursor.
3. Reconcile local submitted records and Gmail events by stable identity.
4. Produce a dry-run diff: additions, merges, conflicts, and unresolved records.
5. Apply the diff only after operator review, then regenerate the Markdown
   tracker and run the digest locally without notification.

## Operating budget

- Digest: zero provider calls; one local run per day only when evidence changed.
- Mail retrieval/filtering: zero provider calls.
- Ambiguous classification: zero or one batched t0 call per check.
- Historical repair: one bounded batch at a time with resumable checkpoints.
- Never install or start a persistent scheduler until its enabled workflows and
  expected daily call budget have been reviewed.
