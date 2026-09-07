# Stage 6: Grow Through Surfaces, Schedules, And Approval

Goal: connect more ways to use Henry without broadening its authority.

## Do

Read the surface and automation docs:

```bash
sed -n '1,220p' docs/modules/workflows.md
sed -n '1,220p' docs/modules/gmail.md
sed -n '1,180p' docs/modules/telegram.md
sed -n '1,120p' docs/modules/pr-review.md
```

Try local surfaces:

```bash
henry ask "what can you do from this checkout?"
henry repl
henry dashboard
henry status
```

Inspect schedules and workflows:

```bash
henry schedule list
henry workflow list
henry schedule install
```

Inspect approvals:

```bash
henry approve list
```

Stage a manual email only in a private configured setup:

```bash
henry draft mail --to person@example.com --subject "Test" --body "This is a staged draft."
henry approve list
```

## Check

Approval commands are separate:

```text
henry approve list
henry approve approve <id>
henry approve send <id>
```

Scheduling commands exist as:

```text
henry schedule list|run <id>|daemon|install
henry workflow list|show <name>|run <name>|logs <name>|daemon
```

## Learn

Growth means adding surfaces and repeatable workflows while keeping execution
rules stable. Dashboard, REPL, Telegram, scheduler, Gmail drafting, and PR review
should all converge on the same runtime and approval store.

Approving and executing are separate operations. A scheduled job or casual
"go ahead" does not approve an outbound item.

## Record

```md
Surface tested:
Schedule inspected:
Workflow inspected:
Approval queue state:
Outbound item staged:
Execution authority:
```

---

Previous: [Stage 5: Memory Vs Knowledge](05-talk-to-henry.md) | Next: [Stage 7: Daily Demo Path](07-build-knowledge.md)

