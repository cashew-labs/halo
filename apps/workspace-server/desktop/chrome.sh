#!/usr/bin/env bash
set -euo pipefail
# Keep Chrome's sandbox enabled; runtime incompatibilities must fail visibly.
# Port 0 binds a free loopback DevTools port and records it in DevToolsActivePort.
exec /usr/bin/google-chrome-stable \
  --no-first-run --no-default-browser-check --restore-last-session \
  --hide-crash-restore-bubble --remote-debugging-port=0 \
  --user-data-dir="$HOME/.config/halo-chrome" "$@"
