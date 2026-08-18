# Public Henry — "talk to my agent" demo (design, approved-pending)

Status: designed 2026-08-09, awaiting Luvish's brain choice + two account steps.

## What this is (and is not)

A **sandboxed public twin** of Henry that portfolio visitors (recruiters) can chat
with. It is NOT the real Henry:

- The real Henry runs on Luvish's personal-subscription CLIs (claude/codex). Those
  are licensed for personal use — proxying them to serve the public would violate
  provider ToS and risk the accounts. The public twin uses a metered/free API key.
- The real Henry holds Gmail access, Engram memory, and filesystem tools. The twin
  gets NONE of that: no tools, no memory db, no personal data — only a baked,
  sanitized knowledge pack (public dossier facts + architecture docs) and a persona
  prompt. It introduces itself as the demo twin.

## Cheapest architecture — $0/month

| Layer | Choice | Cost |
| --- | --- | --- |
| Chat UI | `talk-to-henry` page on the portfolio (GitHub Pages) | $0 |
| API relay | Cloudflare Worker (free plan: 100k req/day) — holds the key as a secret, enforces caps | $0 |
| Brain | Gemini Flash free tier (no card, hundreds of requests/day) — or Anthropic Haiku with ~$5 prepaid credit for the real-Claude feel | $0 / $5 one-time |
| Abuse caps | Workers KV free (1,000 writes/day = natural global message ceiling) + per-IP daily cap | $0 |

Notes:
- KV's 1k writes/day IS the budget rail: one write per message → the demo can never
  serve more than ~1k public messages/day, no surprise bills possible on any layer.
- Per-IP cap (e.g. 10 messages/day) + max-output-tokens keeps single abusers out.
- The UI carries an honest line: "demo twin on a free-tier model — the real Henry
  runs Claude + Codex locally on an 8GB M1 Air."
- Later upgrades that stay cheap: Anthropic Haiku ($5 credit ≈ ~1–2k conversations),
  custom domain reuse (worker routes under luvishgulati.com, still $0).

## Safety rails (non-negotiable)

- Separate system prompt; knowledge pack generated ONLY from public files
  (portfolio content-dossier.md + docs/architecture.md) by a build script — never
  from data/, memory/, soul.md, or anything in the private mirror.
- No tool calls of any kind server-side; the Worker is a pure prompt→text relay.
- Visitor text is untrusted: injection-hardened framing, no system-prompt echo,
  output length capped.
- API key lives only as a Worker secret (never in the repo, never client-side).

## What Luvish does (once, ~10 minutes)

1. Pick the brain: Gemini free ($0) or Claude Haiku ($5 credit).
2. Create the free Cloudflare account and run `! npx wrangler login` in a Henry
   session (interactive OAuth — must be your hands).
3. Create the API key (Google AI Studio — free, no card — or Anthropic console
   with $5 credit) and hand it to me ONCE to store as the Worker secret
   (`wrangler secret put`); it never touches git.

Then I build and ship: Worker code + caps, the blueprint-themed chat page on the
portfolio, the knowledge-pack build script, and end-to-end verification.

## Related but different

Luvish chatting with his REAL Henry away from home is a separate, private problem:
Tailscale (free) to the dashboard/web-chat, or the parked two-way Telegram bridge.
The public twin never gains those powers.
