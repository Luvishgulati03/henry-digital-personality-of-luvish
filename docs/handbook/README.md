# Henry Handbook

Welcome. This handbook is a public, user-neutral path for learning Henry by
doing small verified steps on a laptop.

Henry is a terminal-first personal agent kernel. It runs through local provider
CLIs, keeps memory and knowledge local by default, exposes terminal and dashboard
surfaces, and stages outbound actions behind an approval boundary.

The checked-in example instructions and sample persona name the original operator
of this repository. Treat those as example content when forking Henry; the
handbook itself uses neutral language.

## Laptop Setup First

Use a local checkout, not a cloud-synced path. On macOS, avoid `~/Desktop`,
`~/Documents`, Dropbox, OneDrive, and anything under `Library/Mobile Documents`
unless sync is disabled. The setup guide documents a real failure mode where
cloud eviction of `node_modules` files makes `tsc`, `node`, or `npm` hang.

Minimum path:

```bash
node -v
npm -v
git --version
npm install
npx tsc --noEmit
npm test
```

Choose one provider CLI and authenticate from the real user's terminal:

```bash
codex login status
codex login
claude auth status
claude auth login
```

The auth command syntax above was checked against the installed CLI help:
`codex login --help` exposes `login status`; `claude auth --help` exposes
`auth login` and `auth status`.

## Handbook Path

1. [Welcome And Laptop Setup](01-open-the-repo.md)
2. [IDEATION Stage](02-install-and-verify.md)
3. [Soul And Personality](03-shape-the-agent.md)
4. [BUILDING Stage: Reminder Module Walkthrough](04-choose-the-provider.md)
5. [Memory Vs Knowledge](05-talk-to-henry.md)
6. [Grow Through Surfaces, Schedules, And Approval](06-use-memory.md)
7. [Daily Demo Path](07-build-knowledge.md)
8. [Troubleshooting](08-automate-carefully.md)
9. [Extend And Review Safely](09-extend-safely.md)

Templates:

- [IDEATION.md](IDEATION.md)
- [BUILDING.md](BUILDING.md)

## Source Checks

This handbook was grounded in:

- `package.json`
- `src/cli.ts`
- `SETUP.md`
- `docs/architecture.md`
- `docs/design-your-soul.md`
- `docs/module-doctrine.md`
- `docs/modules/knowledge-base.md`
- `docs/modules/reminders.md`
- `docs/modules/workflows.md`
- `docs/modules/gmail.md`
- `docs/modules/telegram.md`
- `docs/modules/pr-review.md`

If a command or behavior changes in source, update the handbook after checking
the new implementation.

