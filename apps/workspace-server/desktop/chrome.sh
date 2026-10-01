#!/usr/bin/env bash
set -euo pipefail
# Keep Chrome's sandbox enabled; runtime incompatibilities must fail visibly.
exec /usr/bin/google-chrome-stable \
  --no-first-run --no-default-browser-check \
  --user-data-dir="$HOME/.config/halo-chrome" "$@"
