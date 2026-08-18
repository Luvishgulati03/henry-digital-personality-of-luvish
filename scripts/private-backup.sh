#!/usr/bin/env bash
# Refresh the PRIVATE full mirror (~/henry-private → github.com/<you>/henry-private).
# The mirror carries everything the public framework repo excludes (soul, memory,
# data, knowledge corpus). Secrets and the >100MB knowledge.db stay out — see
# PRIVATE-README.md in the mirror. Safe to run any time; no-ops when clean.
set -euo pipefail

SRC="${HENRY_DIR:-$HOME/Downloads/henry}"
DEST="${HENRY_PRIVATE_DIR:-$HOME/henry-private}"

if [ ! -d "$DEST/.git" ]; then
  echo "Private mirror not initialized at $DEST — see PRIVATE-README.md" >&2
  exit 1
fi

# The mirror's own .gitignore is the last line keeping secrets off GitHub — refuse
# to sync into a mirror that lost it (audit 2026-08-09 B-M22).
if [ ! -f "$DEST/.gitignore" ]; then
  echo "Private mirror at $DEST is missing its .gitignore — refusing to sync (secrets would be at risk)" >&2
  exit 1
fi

# Checkpoint SQLite WALs into the main db files before copying (audit B-H8): db+wal
# copied sequentially without a snapshot can tear — a restore would silently lose
# the transactions in between. After checkpointing, the wal/shm sidecars are noise.
node -e '
const { createRequire } = require("node:module");
const req = createRequire(process.argv[1] + "/package.json");
const Database = req("better-sqlite3");
for (const db of ["data/engram.db", "data/sessions.db", "data/standups.db", "data/scout.db"]) {
  try { const d = new Database(process.argv[1] + "/" + db); d.pragma("wal_checkpoint(TRUNCATE)"); d.close(); } catch {}
}
' "$SRC" 2>/dev/null || true

rsync -a --delete \
  --exclude node_modules --exclude dist --exclude .git \
  --exclude ".env" --exclude ".env.*" \
  --exclude "data/gmail-token.json" --exclude "data/gmail-credentials.json" \
  --exclude .DS_Store --exclude "data/browser-profile" \
  --exclude "data/knowledge.db" --exclude "data/*.db-shm" --exclude "data/*.db-wal" \
  --exclude "data/*.lock" --exclude "data/*.tmp-*" \
  --exclude .gitignore --exclude PRIVATE-README.md \
  "$SRC/" "$DEST/"

cd "$DEST"
git add -A
if git diff --cached --quiet; then
  # No new changes — but earlier pushes may have failed; never strand commits (audit B-M21).
  if [ "$(git rev-list --count private/main..HEAD 2>/dev/null || echo 0)" -gt 0 ]; then
    git push -q private HEAD:main
    echo "Private mirror: pushed previously-stranded commits."
  else
    echo "Private mirror already up to date."
  fi
else
  git commit -q -m "backup: $(date '+%Y-%m-%d %H:%M') sync from working repo"
  git push -q private HEAD:main
  echo "Private mirror updated and pushed."
fi
