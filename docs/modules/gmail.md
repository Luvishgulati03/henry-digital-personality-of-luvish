# Gmail through the Codex connector

Henry uses the Gmail connector configured in the owner's Codex host. There is no
separate Google Cloud project, OAuth credential JSON, token file, or Henry login.

## Setup

1. Connect Gmail in Codex and grant the intended permissions.
2. Confirm the connector is enabled for the Codex CLI on this machine.
3. Run `npx tsx src/cli.ts gmail inbox --limit 3` as a read-only check.

Ordinary requests, mailwatch, job-email tracking, and drafts use this connector.

## Boundaries

- Inbox reads are schema-bound and must not alter read state, labels, or drafts.
- Drafting is allowed. Drafting is not sending.
- A requested send first creates a `gmail.send` approval with the exact content.
- Codex receives the connector send instruction only after that exact approval is
  explicitly approved and atomically claimed for execution.
- Ordinary chat, mailwatch, and drafting must never ask the connector to send,
  reply, forward, or modify mailbox state.

```bash
npx tsx src/cli.ts gmail inbox --limit 10
npx tsx src/cli.ts gmail draft --to person@example.com --subject "Subject" --body "Body"
npx tsx src/cli.ts gmail draftreplies --limit 5
npx tsx src/cli.ts approve list
```

Approving and executing remain separate. If the connector is unavailable or its
response is malformed, the operation fails closed. Henry never falls back to a
local OAuth implementation or browser automation.
