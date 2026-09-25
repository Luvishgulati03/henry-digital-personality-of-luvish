# Voice (phase 1: engine + launcher)

Henry can hear and speak entirely on-device, using the same local voice stack Kelly uses:
whisper.cpp for speech-to-text and Kokoro (or eSpeak/Piper) for text-to-speech. Nothing is
downloaded by Henry itself, nothing leaves the machine, and the Kokoro worker only ever
listens on loopback with a required bearer token.

This phase ships the engine, the transcript store, and the `henry start` launcher. It does
**not** add dashboard routes or a Talk page yet — that is a later phase, owned separately.

## What exists after this phase

- `src/voice/index.ts` — `LocalVoiceService`: whisper.cpp STT (with an optional `--prompt`
  vocabulary hint) and Kokoro/eSpeak/Piper TTS, with the same byte/char/time limits, no-shell
  subprocess execution, and loopback-only Kokoro enforcement Kelly's voice stack has.
- `src/voice/transcripts.ts` — `VoiceTranscriptStore`: a local SQLite (WAL) store for what
  Henry heard, plus `VoiceSettings` (`retentionDays`, `recordAudio`, `audioRetentionDays`,
  `talkEnabled`, `privateMode`) persisted in `settings.json → voice`. No shop/counter
  semantics carried over from Kelly (no brand/quantity entity extraction, no counter review
  modes).
- `src/voice/roman.ts` — deterministic Devanagari → Roman Hinglish script conversion for the
  transcript the owner reads.
- `src/voice/resolve.ts` — `resolveVoicePaths()`: finds local model/Python assets, Henry's own
  `data/voice/` first, then Kelly's checkout read-only as a fallback. Disables voice with a
  plain message (dashboard still starts) if nothing is found.
- `scripts/voice/kokoro_server.py` + `requirements.txt` — the local Kokoro HTTP worker,
  copied unchanged from Kelly. It authenticates with a bearer token it reads from
  `KELLY_KOKORO_TOKEN` (unchanged script); `henry start` passes Henry's own
  `HENRY_KOKORO_TOKEN` through under that name when it spawns the worker.
- `henry start [--foreground]` — starts the dashboard and, if local voice assets are found,
  the Kokoro worker, and waits for both to report healthy.

## Environment variables

All Henry-side voice configuration uses the `HENRY_` prefix (there is no `src/profile.ts` in
this repo; these are read directly from `process.env`):

| Variable | Purpose |
| --- | --- |
| `HENRY_WHISPER_CPP_PATH` | Path to a whisper.cpp-compatible `whisper-cli` executable. |
| `HENRY_WHISPER_MODEL_PATH` | Path to a multilingual ggml Whisper model. |
| `HENRY_TTS_ENGINE` | `kokoro`, `espeak-ng`, or `piper`. |
| `HENRY_TTS_EXECUTABLE` | Executable path for `espeak-ng`/`piper`. |
| `HENRY_TTS_MODEL_PATH` | Model path, required for `piper`. |
| `HENRY_TTS_VOICE` | Kokoro voice name, used for every language. Default `am_michael` (male, American). An unknown name logs a warning and falls back to the default. |
| `HENRY_TTS_SPEED` | Kokoro speech rate. Default `1.0`, clamped to `0.7`–`1.3`. |
| `HENRY_KOKORO_URL` | Kokoro worker base URL; must be a loopback `http://` origin. |
| `HENRY_KOKORO_TOKEN` | Bearer token for the Kokoro worker (at least 24 characters). |
| `HENRY_VOICE_PYTHON` | Python interpreter with the Kokoro worker's dependencies installed. |
| `HENRY_KOKORO_MODEL_PATH` | Path to the Kokoro ONNX model. |
| `HENRY_KOKORO_VOICES_PATH` | Path to the Kokoro voices file. |

Any of these left unset falls back to `henry start`'s resolver (see below); voice is disabled,
not defaulted, when nothing resolves.

## Ports

- Dashboard: Henry's usual port, `HENRY_PORT` (default `7337`).
- Kokoro worker: `HENRY_KOKORO_URL`, default `http://127.0.0.1:8766`. Deliberately different
  from Kelly's own `8765` so both voice stacks can run at the same time on one Mac.

## Shared models

Henry does not ship or download voice models. `henry start` resolves, in order, per asset:

1. Henry's own `data/voice/models/<file>` (or `data/voice/venv/bin/python`), if present.
2. Kelly's checkout, read-only, at the same relative path under
   `/Users/luvishgulati/Downloads/kelly` — reusing a model set already installed for Kelly
   instead of asking the owner to download the same multi-hundred-megabyte files twice.
3. Otherwise, that asset is absent. If STT or TTS ends up missing any required asset, that
   half of voice is disabled with a clear message; the dashboard still starts.

Expected filenames: `ggml-small-q5_1.bin` (Whisper), `kokoro-v1.0.int8.onnx` (Kokoro model),
`voices-v1.0.bin` (Kokoro voices). `whisper-cli` is auto-discovered on `PATH` and
`/opt/homebrew/bin` if `HENRY_WHISPER_CPP_PATH` is not set.

## `henry start`

```bash
henry start              # opens a new Terminal window (macOS) running the foreground form
henry start --foreground # runs the dashboard (+ Kokoro worker, if resolved) in this shell
```

No `--demo`, `--trade`, or `--public` flags — those were Kelly-specific (demo catalogue
seeding, shop trade packs, public tunnels). Henry never opens a public link. `henry start`
never keeps the Mac awake, since it never turns on a tunnel.

Startup waits for the Kokoro worker's `/health` (only if voice resolved) and the dashboard's
`/api/health`, then prints:

```
Henry is ready.
Dashboard: http://127.0.0.1:7337
Talk: http://127.0.0.1:7337/talk
```

(The `/talk` route itself lands in a later phase; this phase only prints the URL it will use.)

## Voice safety

A voice turn is a speech-to-text transcript, not proof of authority: anyone near the
microphone, or a misheard word, can produce it. Henry treats it with three layers, strongest
first.

1. **Read-only sandbox (default).** Unless `voice.allowWrites` is on, every voice turn runs
   with `readOnly: true`, the same mode Luna research uses.
   - Codex: `codex exec --sandbox read-only` (resumed sessions use `-c sandbox_mode="read-only"`).
     Shell commands cannot write files, and the sandbox also blocks network sockets, including
     loopback, so a voice turn cannot `curl` the dashboard at `127.0.0.1:7337`. Codex's built-in
     web search still works, because it runs outside the shell sandbox.
   - Claude: `--permission-mode dontAsk --allowedTools Read,Grep,Glob,WebSearch,WebFetch
     --disallowedTools Bash,Edit,Write,NotebookEdit`. No shell, no file edits; web search and
     fetch stay available.

   So by voice Henry can answer, look things up, search the web, research, and recall. It
   cannot edit files, stage drafts or approval items, set reminders, or run anything that
   writes. Asked to do one of those, it says so in one sentence and offers to do it when you
   type the request.
2. **Environment flag.** Every voice turn, read-only or not, runs its provider child with
   `HENRY_VOICE_TURN=1`. Every approve, claim, execute, and send path refuses under that flag,
   and sending connector tools (Gmail send, mail MCP servers) are disabled for the turn.
3. **Chat-route skip.** `/api/chat/send` never runs the typed approval grammar on a voice
   turn, so "approve 123" said aloud reaches the model as ordinary words. While a *writable*
   voice turn is in flight, the dashboard's approval routes and typed approval grammar return
   409. Read-only voice turns don't block your own dashboard approvals, because the sandbox
   has no network to reach them.

### `voice.allowWrites`

Set `"voice": { "allowWrites": true }` in `data/settings.json`, or export
`HENRY_VOICE_ALLOW_WRITES=1`, to let voice turns run with Henry's normal writable
permissions (edit files, stage drafts). `HENRY_VOICE_ALLOW_WRITES=0` forces it off whatever
the settings say. Default: off.

With `allowWrites` on, layer 1 is gone. What stops a voice turn from approving or sending is
then:

- the `HENRY_VOICE_TURN` flag, which a model with a full shell can remove
  (`env -u HENRY_VOICE_TURN ...`), or work around by editing `data/approvals.json` directly or
  by using its own credentials;
- the dashboard's 409 in-flight gate, which only covers the dashboard itself;
- the prompt, which tells Henry that drafts are allowed but approvals and sends never are.

That makes "never approve or send by voice" a prompt-level promise, not a code guarantee,
whenever `allowWrites` is on. Leave it off unless you accept that trade-off.

In both modes the spoken reply is also filtered before speech. Private mode (`voice.privateMode`
or `HENRY_VOICE_PRIVATE=1`) replaces it with a neutral status line. With private mode off,
emails, phone numbers, OTPs, account numbers, and keys are redacted. A read-only turn can still
*read* local files, so what it shows on screen is governed by the prompt's privacy rules.

## Henry Talk (phase 3: dashboard voice)

`/talk` is the hands-free voice page: tap the orb, Henry greets you ("Hey Luvish. I'm
listening."), and from then on the mic re-arms itself after every reply until you tap again,
press Escape, or stay silent (a "Still here. What do you need?" reprompt after 8 s, then a
soft chime and sleep). It is owner-only like every other dashboard page (single admin role,
loopback bypass) and runs entirely on this Mac.

Entry points:

- `http://127.0.0.1:7337/talk` directly (the URL `henry start` prints);
- the **talk ↗** link on the dashboard rail;
- the **Talk** chip in chat, which opens the page in an overlay joined to the open
  conversation (`/talk?embed=1&captions=1&conversationId=…`). Spoken turns land in that thread
  and the chat refreshes after each one; closing the overlay (✕ or Escape) blanks the frame so
  the microphone is released.

### One ongoing voice conversation

Opened directly, Talk uses ONE conversation titled **Voice** for every session, so Henry
remembers earlier voice sessions. Its id is kept in the browser's `localStorage` under
`henry.voice.conversationId`; if that conversation was deleted, the next session (or the next
turn, on a 404) creates a fresh "Voice" thread. The embedded overlay never touches this key.

### How a turn flows

1. **Speech onset.** Silero VAD (`@ricky0123/vad-web` 0.0.31 on `onnxruntime-web`) runs in the
   page, served from `node_modules` through `/vendor/vad/<name>` under a fixed allowlist
   (anything else, including traversal attempts, is a 404). If the bundle or model cannot load,
   the page falls back to a simple energy VAD. Short end-of-turn window (700 ms), switched to a
   longer one (1.4 s) for requests over 4 s, hard cap 25 s.
2. **Transcription.** The page uploads a 16 kHz mono WAV to `POST /api/voice/transcribe`.
   whisper.cpp gets a short vocabulary prompt (Henry, Luvish, Kelly, Codex, Claude, Engram, Luna,
   …) and Whisper's native script is kept (Devanagari stays Devanagari). Private project names go
   in `HENRY_VOICE_VOCABULARY` (comma-separated, local `.env`), never in code. The words are stored
   in the transcript store with surface `talk`; the activity log gets timing and size only.
3. **The turn.** The transcript goes to `/api/chat/send` with `voice: true`, so every phase-2
   rail applies (read-only sandbox by default, `HENRY_VOICE_TURN`, no typed approval grammar).
4. **Holding phrases.** Only a lookup hears one. The server sends a `gathering` SSE event once
   per voice turn: `{reason:"request"}` up front when the words clearly ask for research or a
   lookup (research, look up, search, find, check my, what's the latest, summarise, news, jobs,
   email/inbox/mail, calendar), or `{reason:"tool"}` the first time the provider starts a command,
   tool call, or web search. Chit-chat never gets it. The page then plays one of a small rotating
   set of short holding lines (for example "Chasing that down.", "Digging through the files.")
   and, if still waiting, a second, different one from the same set. They describe looking, never
   claim the work is done, and never promise a time.
5. **Speech.** Each `spoken` line is queued and played in order (half-duplex: the mic is off
   while Henry speaks). `POST /api/voice/speak` re-applies the privacy filter on the server
   before synthesis: private mode turns anything into a neutral status line, otherwise emails,
   phones, OTPs, account numbers and keys are redacted. With `chunk: true` the response is
   `application/x-henry-wav-seq`: frames of a 4-byte big-endian length followed by one WAV each.

Captions are on by default (you read along); `?captions=0` hides them. The mute button stops
Henry's voice but keeps captions.

### Routes

| Route | Purpose |
| --- | --- |
| `GET /talk` | The Talk page. |
| `GET /api/voice/status` | `{available, sttEnabled, ttsEnabled, talkEnabled, privateMode, allowWrites, ttsVoice?, ttsSpeed?, reason?}`. |
| `POST /api/voice/transcribe` | 16 kHz WAV body (max 8 MB) → `{text, transcriptId}`; nothing kept in private mode. |
| `POST /api/voice/speak` | `{text, chunk?}` → WAV, or the framed sequence; redacted / private-mode line only. |
| `GET /api/voice/greeting`, `/reprompt`, `/filler?v=0..N` | Fixed phrases, synthesised once and cached in `data/voice/cache/` (0600), keyed by voice + speed + text so a changed `HENRY_TTS_VOICE`/`HENRY_TTS_SPEED` re-renders instead of replaying an old clip. |
| `POST /api/voice/talk/session` | `{event:"start"}` / `{event:"end", turns, reason}` → `talk.session.started/ended` activity. |
| `GET/POST /api/voice/settings` | `privateMode`, `allowWrites`, `talkEnabled`, `retentionDays` (same-origin writes). |
| `GET /api/voice/transcripts` | Recent transcripts, text only (no audio paths). |
| `GET /vendor/vad/<name>` | Allowlisted VAD/ONNX runtime assets from `node_modules`. |

With STT or TTS not configured these routes answer cleanly (503/404 with a plain message), the
status says why, and the Talk page shows "Voice is off" instead of a broken orb.

### Voice settings card

The dashboard's **voice** card toggles private mode, allow writes (with the warning "Voice can
stage drafts; approvals and sends stay typed." and a confirm), the Talk page itself, and how many
days transcripts are kept. A value forced by `HENRY_VOICE_PRIVATE` or `HENRY_VOICE_ALLOW_WRITES`
shows its effective state, locked, with a note saying which variable set it. It also shows the
active Kokoro voice and speed (`HENRY_TTS_VOICE`/`HENRY_TTS_SPEED`), read-only.
