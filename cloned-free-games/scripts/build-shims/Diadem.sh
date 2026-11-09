#!/usr/bin/env bash
# Build shim for Diadem (github.com/fergusq/diadem).
#
# src/app.css does `@import "./custom.css"` for player-supplied theming, and that file is
# gitignored upstream — so a clean clone cannot build. An empty stylesheet is the upstream
# default: the app's own styles still apply, nothing is overridden.
set -euo pipefail
[ -f src/custom.css ] || : > src/custom.css
