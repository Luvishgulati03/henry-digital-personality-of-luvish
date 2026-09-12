# Connector and runtime audit — 2026-09-13

## Scope

Reviewed every `ProviderRunner.run` caller, every machine-consumed model response, workflow timeout configuration, Codex MCP inheritance, and recent activity-log latency/failures.

## Findings and fixes

| Finding | Impact | Resolution |
| --- | --- | --- |
| MailWatch and its historical backfill consumed delimiter-formatted prose | Connector commentary could corrupt parsing and prevent cursor updates | Migrated both paths to JSON Schema, final-agent-message extraction, validation, and fail-closed persistence |
| Job-alert learning consumed `ALERT|...` lines | A valid connector run could silently produce zero learned searches | Migrated live Codex runs to JSON Schema and explicit Gmail connector routing; retained legacy parsing only for compatibility |
| Reply drafting consumed blocks plus summary lines | Multiline bodies and progress text could be dropped or misparsed | Migrated to schema-bound reply objects containing full bodies; outbound sending remains impossible from this service |
| Provider-data workflows repeated success checks inconsistently | Empty, limited, or non-zero runs could be mistaken for usable data | Added a shared `requireProviderResponse` fail-closed boundary |
| Main-brain connector behavior was implicit | Henry could reach for browser/local integrations even when a semantic connector existed | Added a connector-first routing contract to the main brain and public architecture guide |
| MailWatch prompt claimed a stale 45-minute cadence | Operator expectations differed from actual five-random-check plan | Corrected the runtime prompt documentation |
| Enabled Sentry MCP is unauthenticated | Repeated MCP startup/auth warnings add noise and can add launch work | Keep disabled until authenticated, or authenticate it before use; Gmail is configured separately and healthy |

## Measured runtime evidence

From the current local activity history:

- MailWatch completed runs averaged about 130 seconds; the slowest was about 297 seconds.
- Draft-reply runs averaged about 88 seconds; the slowest was about 196 seconds.
- MailWatch recorded 17 historical envelope timeouts.
- Several Codex launches logged an unauthenticated Sentry MCP startup failure.

These figures are historical and include older implementations. Future activity logs should be compared after enough new runs accumulate.

## Connector adoption policy

Ordinary interactive requests need no connector-specific sub-agent or skill. Codex receives the host's enabled MCP tools and can select them from natural language. Add a skill only for a repeatable procedure or domain policy. Add schema-bound application code for unattended workflows, machine-consumed output, cursor advancement, or sensitive side effects.

## Remaining intentional constraints

- Provider envelopes remain. They kill hung child processes; they are not scheduling timers.
- Long-running research workflows retain longer explicit envelopes because their expected workload differs from inbox classification.
- Browser automation remains for sources without semantic connectors.
- Connector tools never override Henry's approval queue or outbound rules.
