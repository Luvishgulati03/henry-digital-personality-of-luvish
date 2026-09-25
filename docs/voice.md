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
