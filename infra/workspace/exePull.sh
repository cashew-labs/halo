#!/usr/bin/env bash
# Run as root on the guest. The caller supplies a fresh token on stdin for each
# attempt and wraps this script in GNU timeout, independently of the SSH client.
set -euo pipefail
registry=${1:?}
source_digest=${2:?}
image=${3:?}
interval=${4:-30}
config=$(mktemp -d)
heartbeat=
cleanup() {
  result=$?
  trap - EXIT
  if [ -n "$heartbeat" ]; then
    kill "$heartbeat" 2>/dev/null || true
    wait "$heartbeat" 2>/dev/null || true
  fi
  rm -rf "$config"
  exit "$result"
}
trap cleanup EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT
# Serialize attempts even if a previous runner lost its SSH connection. This
# lock and the caller's guest-side timeout bound the lifetime of that attempt.
exec 9>/run/halo-image-pull.lock
flock -w 30 9
read -r token
printf '%s' "$token" | DOCKER_CONFIG=$config timeout --kill-after=5s 30s docker login -u oauth2accesstoken --password-stdin "$registry" >/dev/null
unset token
started=$SECONDS
(
  sleeper=
  trap 'if [ -n "$sleeper" ]; then kill "$sleeper" 2>/dev/null || true; fi; exit' TERM HUP INT
  while true; do
    sleep "$interval" &
    sleeper=$!
    wait "$sleeper"
    echo "HALO_PULL elapsed=$(( SECONDS - started ))s image=$source_digest"
    timeout --kill-after=5s 10s df -h /var/lib/docker || true
  done
) &
heartbeat=$!
# Keep Docker's layer progress in the CI log. The heartbeat also reports an
# unpacking stall, during which Docker itself can be silent.
DOCKER_CONFIG=$config docker pull --platform linux/amd64 "$source_digest"
docker tag "$source_digest" "$image"
# Keep only the halo-workspace name, which the image cleanup tracks.
docker rmi "$source_digest" >/dev/null
echo "HALO_PULL_READY image=$image"
