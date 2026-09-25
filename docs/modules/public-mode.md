# Public mode: Henry on your own domain

Public mode puts Henry on a public link served from your Mac through a Cloudflare
named tunnel, for example `https://henry.your-domain.com`. The dashboard never
leaves `127.0.0.1`; `cloudflared` forwards the public hostname into it, and the
server decides what a tunnelled request may reach.

The link opens a **landing page** with two choices:

1. **Visitor** ("I'm here to learn about <owner>"): the public **chat** face and
   the hands-free **talk** face. No login. Henry answers as "Henry, <owner>'s chief
   of staff and AI twin", in the third person, only from the published public
   knowledge pack.
2. **Owner**: a password sign-in. After it, the owner gets the full dashboard
   through the tunnel (chat with memory, approvals queue, every admin page and
   API), exactly what `127.0.0.1` gives.

## Set it up

```bash
brew install cloudflared
henry tunnel setup henry.your-domain.com     # one-time; --name henry is the default
henry admin password                        # optional: enables the Owner sign-in
# publish the public knowledge pack (another module owns `henry public pack ...`)
henry start --public
```

`henry tunnel setup <hostname> [--name henry]` logs in to Cloudflare (browser),
creates or reuses the named tunnel, routes the hostname to it (never
`--overwrite-dns`; a hostname already routed elsewhere stops with a message), and
writes `HENRY_CLOUDFLARE_TUNNEL` and `HENRY_PUBLIC_HOST` to `.env`. It never writes
`HENRY_TUNNEL`: the link only comes up through `henry start --public`.
`henry tunnel status` reports readiness without changing anything.

`henry start --public [cloudflare]` refuses to start unless the tunnel is set up and
the published pack (`<data dir>/public-pack/published/*.md`) exists and is not
empty. It sets `HENRY_TUNNEL=cloudflare` and `HENRY_PUBLIC_ORIGIN` for the dashboard
process only, waits for `/api/health` to report `remote.active`, and keeps the Mac
awake with `caffeinate` while the link is online. Without `--public` the tunnel is
forced off.

## What a visitor can reach

Unauthenticated tunnel traffic can reach only this allowlist
(`PUBLIC_TUNNEL_ROUTES` in `src/public/surface.ts`, plus `TUNNEL_LOGIN_ROUTES` in
`src/dashboard/server.ts`):

```text
GET  /                          landing page
GET  /public/chat, /public/talk the two faces
GET  /public/manifest.webmanifest, /public/icon.svg, /vendor/vad/<allowlisted asset>
GET  /api/health                { ok, timestamp, remote: { active } }
GET  /api/public/config         owner display name, opening line, availability
GET  /api/public/voice/greeting|reprompt|filler
POST /api/public/chat           one sandboxed model turn, SSE
POST /api/public/reset          new conversation
POST /api/public/ping           ping the owner (Telegram)
POST /api/public/voice/transcribe, /api/public/voice/speak
GET  /login, POST /login, GET /logout
```

Everything else is `302 /login` for a page or `401` for an API, and needs a valid
owner session. `tests/public-routes.test.ts` walks every route the server registers
through the tunnel and fails if anything else answers.

A request counts as tunnelled when it carries any Cloudflare or proxy header
(`CF-Connecting-IP`, `CF-Ray`, `X-Forwarded-*`, ...), a non-loopback `Host`, or comes
from a non-loopback peer. That errs towards "public": a stranger can only make a request
look more public, never local. The local-admin bypass and the dashboard token never
apply to a tunnelled request.

## How a public turn is sandboxed

A public turn goes through Henry's own `ProviderRunner` (Claude first by default,
Codex as failover, both locked down; `HENRY_PUBLIC_PROVIDER`, `HENRY_PUBLIC_FAILOVER`)
with `publicTurn` set (`src/providers/public-sandbox.ts`):

- **Claude**: `--tools ""` (no built-in tools), `--safe-mode`, `--strict-mcp-config`
  with an empty `--mcp-config`, `--setting-sources ""`, `--permission-mode dontAsk`,
  the file/shell/web tools also denied by name, `--no-session-persistence`, and
  `--system-prompt` replacing the default agent prompt. The run's init event must
  report no tools and no MCP servers, or the answer is discarded.
- **Codex**: `--disable shell_tool` and `unified_exec` (no shell, so no file reads),
  connectors/plugins/browser/image/multi-agent/hooks/memories off,
  `--ignore-user-config`, `--ignore-rules`, `--sandbox read-only`, web search off,
  `project_doc_max_bytes=0`, `--ephemeral`. Any event other than a plain message
  (a command, file change, MCP or tool call, or anything unknown) discards the answer.
- Both run in an empty scratch directory outside the repository, with a minimal
  environment (no GitHub tokens, no `HENRY_*` keys) plus `HENRY_PUBLIC_TURN=1`.
  Every approve, claim, execute, send, reminder, tweet, standup and Telegram path
  refuses under that flag, and a process carrying it never starts another run.
- No memory is read. The persona is read from your private `soul.md` section
  `## Public mode (recruiters and visitors)` plus `personality.md` (a generic rule
  set when the section is missing), the pack is inlined, the visitor's history is
  capped, and the visitor's message is quoted and labelled untrusted.
- An output guard replaces any reply that looks like a local path, a private file
  name, a credential, a configured secret, or the prompt's own scaffolding.

## Limits

Message length (`HENRY_PUBLIC_MAX_MESSAGE_CHARS`, 1000), audio size and duration
(`HENRY_PUBLIC_MAX_AUDIO_BYTES`, `HENRY_PUBLIC_MAX_AUDIO_SECONDS`), per-visitor and
per-client rates (`HENRY_PUBLIC_VISITOR_PER_MINUTE|HOUR`,
`HENRY_PUBLIC_CLIENT_PER_MINUTE|HOUR`), and a small global cap on model turns
(`HENRY_PUBLIC_MAX_CONCURRENT`, `HENRY_PUBLIC_MAX_QUEUE`,
`HENRY_PUBLIC_QUEUE_WAIT_SECONDS`). The client key is `CF-Connecting-IP` only for
tunnelled requests, and only for rate limiting, never for authorisation. The speech
endpoint only speaks a reply Henry already gave that visitor.

## Visit notes and owner pings

When a visitor session idles (`HENRY_PUBLIC_IDLE_MINUTES`, 15), the server writes one
Engram note tagged `visitor`: the questions asked and any name, company, role or
contact they volunteered, all quoted and marked untrusted. One optional tool-less,
sandboxed extraction turn (`HENRY_PUBLIC_SUMMARISE`) may fill in
`{name, company, role, hiring_for, contact, questions[]}`; only that exact JSON shape is
accepted.

Telegram goes to the owner only (the configured `HENRY_TELEGRAM_CHAT_ID`): a short
notice when a new visitor starts (`HENRY_PUBLIC_NOTICE_MINUTES`), and the visitor's
"Ping" with their details marked unverified. One ping per visitor and at most
`HENRY_PUBLIC_PINGS_PER_HOUR` overall.

## Owner access through the link

- Set the password with `henry admin password` (hidden prompt, typed twice, at least
  12 characters). It is stored as a scrypt hash in `<data dir>/dashboard/dashboard.db`,
  never in `.env`. The Owner button says "not set up" until then.
- The session cookie is `HttpOnly`, `SameSite=Strict`, and `Secure` over the tunnel. A
  session dies after 12 hours idle and 7 days at most. `/logout` ends it;
  `henry admin logout-all` ends every session, and changing the password does too.
- Login is throttled by username alone: five failures lock it for 15 minutes, doubling
  with each further lock, whatever address the attempts claim to come from. Every
  successful remote sign-in, and every burst of failures, sends you a Telegram notice.
- Every state change through the tunnel needs an `Origin` that exactly matches the
  public origin.
- `HENRY_REMOTE_ADMIN=off` turns owner sign-in (and every owner session) off through
  the tunnel. Loopback access is unchanged.
- Approvals do not change: approve and send stay separate, explicit actions.

**Risk note.** With owner access on, your email, calendar, memory and approvals sit
behind one password on the public internet. Use a long unique password, watch the
sign-in notices, and set `HENRY_REMOTE_ADMIN=off` whenever you do not need it.

## `/api/health` for a portfolio pill

`GET /api/health` returns `{ ok, timestamp, remote: { active } }` and nothing else.
List exact https origins in `HENRY_HEALTH_CORS_ORIGINS` (comma-separated, e.g.
`https://your-domain.com`) to let those sites read it cross-origin; the default is
none.
