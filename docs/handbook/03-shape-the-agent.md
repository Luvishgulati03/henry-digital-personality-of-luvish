# Stage 3: Soul And Personality

Goal: separate hard operating rules from voice and preferences.

## Do

Read the persona guide and examples:

```bash
sed -n '1,220p' docs/design-your-soul.md
sed -n '1,180p' soul.example.md
sed -n '1,180p' personality.example.md
```

For a private setup, create local persona files:

```bash
cp soul.example.md soul.md
cp personality.example.md personality.md
```

Verify they exist locally:

```bash
test -f soul.md && test -f personality.md && echo ok
```

## Check

Use `soul.md` for non-negotiables: identity, approval boundaries, and channel
rules. Use `personality.md` for style, judgment preferences, and memory habits.

The shipped examples name this repository's original operator. A fork should
replace those local persona files with the new user's own terms, while keeping
the outbound approval rule intact.

## Learn

Persona files are injected into provider calls, so they should be short and
specific. Do not soften a hard rule into "use judgment." If a new channel can
send outward, extend the hard rule to name that channel.

## Record

```md
Agent name:
User term of address:
Hard outbound rule:
Voice preferences:
Memory preferences:
```

---

Previous: [Stage 2: IDEATION](02-install-and-verify.md) | Next: [Stage 4: BUILDING](04-choose-the-provider.md)

