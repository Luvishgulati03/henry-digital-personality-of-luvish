# LinkedIn session for the scout — login flows

Diagnosis (2026-08-11): the login window works; **Google's OAuth** is what refuses
("This browser or app may not be secure") — Google blocks Sign-in-with-Google inside
automation browsers as policy. LinkedIn's own email+password form has no such block.
X login succeeded in the same window for exactly this reason.

## Flow A — direct password login (primary, zero code)

1. `henry jobs login` (own terminal) → in the LinkedIn tab, IGNORE the Google button.
2. Enter email + LinkedIn password in the form fields. An OTP/verification challenge
   may appear once — complete it; the session then persists in the profile.
3. If the account is Google-SSO-only (no password set): real Chrome →
   linkedin.com → Settings → Sign in & security → Change password (link arrives by
   email) → then do step 1-2.

## Flow B — cookie import (implemented: `henry jobs linkedin-cookie`)

For when a password login misbehaves. LinkedIn's session rides one cookie: `li_at`.
1. In REAL Chrome (already logged in): DevTools → Application → Cookies →
   https://www.linkedin.com → copy the `li_at` value.
2. `henry jobs linkedin-cookie` (own terminal) → paste the value → Henry injects it
   into the scout profile and verifies by loading the feed.
Notes: the cookie is a session credential — it is stored ONLY inside the local
browser profile (gitignored, backup-excluded), never in .env or logs. Rotating your
LinkedIn password invalidates it; re-import then.

## Flow C — CDP attach (documented fallback, not built)

Launch real Chrome with --remote-debugging-port and have the scout connect over CDP,
reusing the live session. Most human-authentic; most moving parts (Chrome must be
started with the flag; Playwright attach lifecycle). Build only if A and B both fail.
