#!/usr/bin/env bash
set -euo pipefail
: "${EXE_PRIVATE_KEY_PATH:?}" "${WORKSPACE_IMAGE:?}" "${RUNNER_TEMP:?}" "${VERSION:?}" "${SOURCE_SHA:?}"
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
# A daemon's image ID can change across save/load storage backends. Transfer a
# tag derived from the immutable registry digest so both daemons resolve it.
source_digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$WORKSPACE_IMAGE")
image="halo-workspace:${source_digest##*:}"
docker tag "$WORKSPACE_IMAGE" "$image"
restore_paused=false
clean_images_on_exit=false
restore_sleep_on_exit() {
  result=$?
  trap - EXIT
  # A failed update must not leave its image behind to fill the next attempt's disk.
  if [ "$clean_images_on_exit" = true ]; then remove_unused_images; fi
  if [ "$restore_paused" = true ]; then
    if ! ssh "${ssh_args[@]}" exe.dev pause "$vm"; then
      echo "Failed to restore $vm to its paused state" >&2
      result=1
    fi
  fi
  exit "$result"
}
trap restore_sleep_on_exit EXIT

# Keep only the image the halo service is configured to run and any image a
# container uses; everything else is an earlier release or a failed install.
remove_unused_images() {
  ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo bash -s' <<'CLEAN' || echo "Could not remove unused workspace images on $vm" >&2
set -euo pipefail
keep=$(cat /etc/halo/image 2>/dev/null || true)
in_use=$(docker ps -aq | xargs -r docker inspect --format '{{.Config.Image}}')
for image in $(docker images --format '{{.Repository}}:{{.Tag}}' halo-workspace); do
  if [ "$image" = "$keep" ] || grep -qxF "$image" <<< "$in_use"; then continue; fi
  docker rmi "$image" >/dev/null
done
docker image prune -f >/dev/null
CLEAN
}

# A full disk also stops the running workspace, so refuse the transfer when the
# new image would not fit. containerd keeps the compressed layers and their
# unpacked snapshot, so loading needs about twice the image's size.
require_free_space() {
  local image_gib needed_gib free_gib
  image_gib=$(( ($(docker image inspect --format '{{.Size}}' "$image") + 1073741823) / 1073741824 ))
  needed_gib=$(( image_gib * 2 + 5 ))
  free_gib=$(ssh "${ssh_args[@]}" "$vm.exe.xyz" "df --block-size=1G --output=avail /var/lib | tail -n 1" | tr -d ' ')
  if [ "$free_gib" -lt "$needed_gib" ]; then
    echo "$vm has ${free_gib}GB free but needs ${needed_gib}GB to load $image; leaving the running workspace unchanged" >&2
    exit 1
  fi
}

case "$mode" in
  template)
    : "${EXE_TEMPLATE_VM_NAME:?}"
    vm="$EXE_TEMPLATE_VM_NAME"
    restore_paused=true
    # Completed template names are immutable; incomplete bootstrap can be retried.
    details=$(ssh "${ssh_args[@]}" exe.dev ls "$vm" --json)
    if [ "$(jq '.vms | length' <<< "$details")" = 0 ]; then
      ssh "${ssh_args[@]}" exe.dev new --name="$vm" --image=ghcr.io/boldsoftware/exeuntu@sha256:d410ce9638ffe170e965b6ac4cfd90a868887faf6c3f256c038c7dd8c83af0d2 --disk=50GB --json
    elif jq -e '.vms[0].status == "paused" or .vms[0].status == "suspended"' <<< "$details" >/dev/null; then
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
    if [ "$status" = paused ] || [ "$status" = suspended ]; then
      restore_paused=true
      ssh "${ssh_args[@]}" exe.dev resume "$vm"
    fi
    # A release is active work: refresh the idle clock using the workspace's
    # existing scoped reporter before transferring bytes to a resumed guest.
    if ! ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo docker exec -i halo-workspace node --import /opt/halo/node_modules/tsx/dist/loader.mjs --input-type=module' <<'ACTIVITY'
import fs from 'node:fs/promises';
import { ControlPlaneWorkReporter } from '/opt/halo/packages/workspace-server/src/server/ControlPlaneWorkReporter.ts';
const { runtime } = JSON.parse(await fs.readFile('/etc/halo/workspace-server.json', 'utf8'));
const reporter = new ControlPlaneWorkReporter(runtime);
const result = await reporter.report(false, new AbortController().signal);
if (result instanceof Error) { console.error(result.message); process.exitCode = 1; }
ACTIVITY
    then
      # A crashed or stopped old container must still receive the repair image.
      echo 'Could not report release activity; continuing with the workspace update' >&2
    fi
    clean_images_on_exit=true
    remove_unused_images
    require_free_space
    docker save "$image" | gzip -1 | ssh "${ssh_args[@]}" "$vm.exe.xyz" 'gzip -d | sudo docker load'
    scp "${ssh_args[@]}" "$root/infra/workspace/exeTemplate.sh" "$root/infra/workspace/desktop-seccomp.json" "$vm.exe.xyz:/tmp/"
    ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo bash /tmp/exeTemplate.sh '$image' update-host && sudo /usr/local/bin/halo-workspace-upgrade '$image'"
    ready=false
    for attempt in $(seq 1 60); do
      if info=$(ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo docker exec halo-workspace node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json' 2> "$RUNNER_TEMP/exe-status-error.log"); then
        if jq -e --arg revision "$SOURCE_SHA" --argjson protocols "$(jq -c .protocols.workspace.supported "$release_manifest")" '.build.revision == $revision and (.supportedProtocols // [.protocolVersion]) == $protocols' <<< "$info" >/dev/null; then ready=true; break; fi
      fi
      sleep 5
    done
    if [ "$ready" != true ]; then cat "$RUNNER_TEMP/exe-status-error.log" >&2; echo "$vm did not become ready for $image" >&2; exit 1; fi
    # Cleanup must run while the guest is awake, before it is paused again.
    clean_images_on_exit=false
    remove_unused_images
    if [ "$status" = paused ] || [ "$status" = suspended ]; then ssh "${ssh_args[@]}" exe.dev pause "$vm"; fi
    restore_paused=false
    echo "HALO_WORKSPACE_READY image=$image revision=$SOURCE_SHA"
    ;;
  *) echo "Mode must be template or update" >&2; exit 1 ;;
esac
