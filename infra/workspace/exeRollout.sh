#!/usr/bin/env bash
set -euo pipefail
: "${EXE_PRIVATE_KEY_PATH:?}" "${WORKSPACE_IMAGE:?}" "${RUNNER_TEMP:?}" "${VERSION:?}" "${GITHUB_SHA:?}"
mode=${1:?Usage: exeRollout.sh template|update}
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
release_manifest=${RELEASE_MANIFEST:-"$root/releases/$VERSION.json"}
ssh_args=(-F /dev/null -i "$EXE_PRIVATE_KEY_PATH" -o IdentitiesOnly=yes -o IdentityAgent=none
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$root/infra/workspace/exe-known-hosts"
  -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
# Registry credentials are used only by this trusted runner; guests receive image bytes.
export DOCKER_CONFIG="$RUNNER_TEMP/exe-registry"
mkdir -p "$DOCKER_CONFIG"
gcloud auth print-access-token | docker login -u oauth2accesstoken --password-stdin "${WORKSPACE_IMAGE%%/*}"
docker pull --platform linux/amd64 "$WORKSPACE_IMAGE"
image=$(docker inspect --format '{{.Id}}' "$WORKSPACE_IMAGE")
restore_paused=false
restore_sleep_on_exit() {
  result=$?
  trap - EXIT
  if [ "$restore_paused" = true ]; then
    if ! ssh "${ssh_args[@]}" exe.dev pause "$vm"; then
      echo "Failed to restore $vm to its paused state" >&2
      result=1
    fi
  fi
  exit "$result"
}
trap restore_sleep_on_exit EXIT
case "$mode" in
  template)
    : "${EXE_TEMPLATE_VM_NAME:?}"
    vm="$EXE_TEMPLATE_VM_NAME"
    restore_paused=true
    # Completed template names are immutable; incomplete bootstrap can be retried.
    details=$(ssh "${ssh_args[@]}" exe.dev ls "$vm" --json)
    if [ "$(jq '.vms | length' <<< "$details")" = 0 ]; then
      ssh "${ssh_args[@]}" exe.dev new --name="$vm" --image=ghcr.io/boldsoftware/exeuntu@sha256:d410ce9638ffe170e965b6ac4cfd90a868887faf6c3f256c038c7dd8c83af0d2 --disk=50GB --json
    elif [ "$(jq -er '.vms[0].status' <<< "$details")" = paused ]; then
      ssh "${ssh_args[@]}" exe.dev resume "$vm"
    fi
    published=$(ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo cat /etc/halo/template-ready 2>/dev/null || true')
    if [ -n "$published" ] && [ "$published" != "$image" ]; then
      echo "Template already exists with another image" >&2; exit 1
    fi
    if [ -z "$published" ]; then
      ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo test ! -f /etc/halo/assignment.json && { sudo test ! -d /var/lib/halo/home || sudo test -z "$(sudo find /var/lib/halo/home -type f -print -quit)"; }'
      ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo date -s '@$(date +%s)' >/dev/null; sudo apt-get update >/dev/null && sudo apt-get install -y docker.io >/dev/null && sudo systemctl enable --now docker"
      docker save "$image" | gzip -1 | ssh "${ssh_args[@]}" "$vm.exe.xyz" 'gzip -d | sudo docker load'
      scp "${ssh_args[@]}" "$root/infra/workspace/exeTemplate.sh" "$root/infra/workspace/desktop-seccomp.json" "$vm.exe.xyz:/tmp/"
      ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo bash /tmp/exeTemplate.sh '$image'"
    fi
    ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo test ! -f /etc/halo/assignment.json && sudo test ! -f /etc/halo/workspace-server.json && sudo test -z "$(sudo find /var/lib/halo/home -type f -print -quit)" && sudo test ! -f /root/.docker/config.json && sudo test ! -f /home/exedev/.docker/config.json && sudo sync'
    ssh "${ssh_args[@]}" "$vm.exe.xyz" "printf '%s\\n' '$image' | sudo tee /etc/halo/template-ready >/dev/null; sudo sync"
    ssh "${ssh_args[@]}" exe.dev pause "$vm"
    restore_paused=false
    echo "HALO_EXE_TEMPLATE_READY name=$vm image=$image"
    ;;
  update)
    : "${INSTANCE:?}"
    vm="$INSTANCE"
    status=$(ssh "${ssh_args[@]}" exe.dev ls "$vm" --json | jq -er '.vms[0].status')
    if [ "$status" = paused ]; then
      restore_paused=true
      ssh "${ssh_args[@]}" exe.dev resume "$vm"
    fi
    docker save "$image" | gzip -1 | ssh "${ssh_args[@]}" "$vm.exe.xyz" 'gzip -d | sudo docker load'
    scp "${ssh_args[@]}" "$root/infra/workspace/exeTemplate.sh" "$root/infra/workspace/desktop-seccomp.json" "$vm.exe.xyz:/tmp/"
    ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo bash /tmp/exeTemplate.sh '$image' update-host && sudo /usr/local/bin/halo-workspace-upgrade '$image'"
    ready=false
    for attempt in $(seq 1 60); do
      if info=$(ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo docker exec halo-workspace node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json' 2> "$RUNNER_TEMP/exe-status-error.log"); then
        if jq -e --arg revision "$GITHUB_SHA" --argjson protocols "$(jq -c .protocols.workspace.supported "$release_manifest")" '.build.revision == $revision and (.supportedProtocols // [.protocolVersion]) == $protocols' <<< "$info" >/dev/null; then ready=true; break; fi
      fi
      sleep 5
    done
    if [ "$ready" != true ]; then cat "$RUNNER_TEMP/exe-status-error.log" >&2; echo "$vm did not become ready for $image" >&2; exit 1; fi
    if [ "$status" = paused ]; then ssh "${ssh_args[@]}" exe.dev pause "$vm"; fi
    restore_paused=false
    echo "HALO_WORKSPACE_READY image=$image revision=$GITHUB_SHA"
    ;;
  *) echo "Mode must be template or update" >&2; exit 1 ;;
esac
