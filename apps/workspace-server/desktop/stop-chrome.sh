#!/usr/bin/env bash
set -euo pipefail
# This also runs inside the old source container during a provider migration.
chrome_lock=$(readlink "$HOME/.config/halo-chrome/SingletonLock" 2>/dev/null || true)
chrome_pid=${chrome_lock##*-}
if [[ ! "$chrome_pid" =~ ^[0-9]+$ ]] || \
  [[ "$(readlink "/proc/$chrome_pid/exe" 2>/dev/null || true)" != /opt/google/chrome/chrome ]]; then
  exit 0
fi
kill -TERM "$chrome_pid" 2>/dev/null || true
for attempt in {1..100}; do
  if [[ ! -e "/proc/$chrome_pid/exe" ]]; then exit 0; fi
  sleep 0.1
done
echo 'Chrome did not save and close within ten seconds' >&2
exit 1
