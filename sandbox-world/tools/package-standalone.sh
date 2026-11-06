#!/usr/bin/env bash
# package-standalone.sh — write the universe into a zip you can carry away.
#
# Why this exists: the artifact is meant to leave the sandbox that built it. So
# this bundles the folder exactly as it runs (vendored three.js included, no
# node_modules, no build step) and drops in a README for the destination.
#
# Deliberately NOT included:
#   universe.json   your saved charter is your state, not part of the artifact.
#                   Its absence is meaningful: no file means no creation, which
#                   is the state this world ships in.
#   node_modules    there are no dependencies. If a folder like that is needed,
#                   something has already gone wrong.
#
# Usage: bash tools/package-standalone.sh [output.zip]
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUT="${1:-$HERE/../arcane-physics-standalone.zip}"
NAME="the-void"

command -v node >/dev/null || { echo "need node to verify the bundle" >&2; exit 1; }

# Refuse to ship a broken world: the tests and the headless boot check are the
# definition of "works here", so a bundle is only produced if they pass.
( cd "$HERE" && npm run --silent verify ) >/dev/null

STAGE="$(mktemp -d)"; trap 'rm -rf "$STAGE"' EXIT
mkdir -p "$STAGE/$NAME"
tar -C "$HERE" -cf - \
  --exclude=./node_modules --exclude=./universe.json --exclude=./.git \
  --exclude=./tools/package-standalone.sh.bak . \
  | tar -C "$STAGE/$NAME" -xf -

cat > "$STAGE/$NAME/README-FIRST.md" <<'TXT'
# the void — read me first

Unzip anywhere. Then, from this folder:

    npm run serve

and open the URL it prints. `npm install` is not needed and will do nothing:
there are no dependencies, and three.js r169 is vendored in `vendor/`.

## Do not double-click index.html

ES modules are refused over `file://` by every mainstream browser (CORS applies
to module scripts, and `file://` has no origin to grant it). This is not a bug in
this world — it is the browser refusing to load modules from an opaque origin.
Any static server fixes it, and `npm run serve` is one:

    npm run serve          # node, no install
    python3 -m http.server 8765   # also fine; use /index.html

To put it on a phone or a headset, zip is portable as-is to any static host
(or https://html.sh for the single-file pages). `ENTER VR` appears in the HUD only
when a WebXR device is actually present.

## What you are looking at

Nothing. On purpose. No ground, no sky, no sun, no direction called down, and no
time until something changes. The palette creates bodies; the console takes text:

    create star name sol
    create earthlike name terra at 1.496e11 0 0 orbit sol
    archipelago

`universe.json` (created when you press save) is the charter of your universe.
Edit or delete it and the open page follows it, because the dev server watches it
and pushes over SSE. Deleting it returns you to the void.

Full explanation in README.md.

## Verify it yourself

    npm run verify     # import graph + 77 physics tests + both boot checks
TXT

rm -f "$OUT"
if command -v zip >/dev/null; then
  ( cd "$STAGE" && zip -qr "$OUT" "$NAME" )
else
  ( cd "$STAGE" && python3 - "$OUT" "$NAME" <<'PY'
import os, sys, zipfile
out, name = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(name):
        dirs[:] = [d for d in dirs if d != "node_modules"]
        for f in files:
            p = os.path.join(root, f)
            z.write(p, p)
PY
  )
fi

# Prove portability where it counts: unpack into a fresh directory outside the
# repo and run the world's own checks from there.
PROVE="$(mktemp -d)"; trap 'rm -rf "$STAGE" "$PROVE"' EXIT
if command -v unzip >/dev/null; then unzip -q "$OUT" -d "$PROVE"; else python3 -m zipfile -e "$OUT" "$PROVE"; fi
( cd "$PROVE/$NAME" && npm run --silent verify >/dev/null ) \
  || { echo "the bundle does not verify outside the repo — refusing to call it standalone" >&2; exit 1; }

FILES=$(find "$PROVE/$NAME" -type f | wc -l)
SIZE=$(du -h "$OUT" | cut -f1)
echo "✓ $OUT  ($SIZE, $FILES files) — verified by running npm run verify inside the extracted copy"
echo "  contents: $(cd "$PROVE/$NAME" && ls | tr '\n' ' ')"
