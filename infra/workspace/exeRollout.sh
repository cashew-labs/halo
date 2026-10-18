#!/usr/bin/env bash
set -euo pipefail
: "${EXE_PRIVATE_KEY_PATH:?}" "${WORKSPACE_IMAGE:?}" "${RUNNER_TEMP:?}" "${VERSION:?}" "${SOURCE_SHA:?}"
mode=${1:?Usage: exeRollout.sh template|update}
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
release_manifest=${RELEASE_MANIFEST:-"$root/releases/$VERSION.json"}
ssh_args=(-F /dev/null -i "$EXE_PRIVATE_KEY_PATH" -o IdentitiesOnly=yes -o IdentityAgent=none
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$root/infra/workspace/exe-known-hosts"
  -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
# Guests pull release images themselves with a token for this read-only account
# (infra/control-plane/index.ts), so only layers they lack cross the network.
image_puller=${EXE_IMAGE_PULLER:-halo-west-image-puller@halo-relay.iam.gserviceaccount.com}
# Both release workflows supply the registry digest. Metadata inspection does
# not require downloading and unpacking the entire image on every runner.
if [[ ! "$WORKSPACE_IMAGE" =~ @sha256:[0-9a-f]{64}$ ]]; then
  echo "WORKSPACE_IMAGE must be pinned by sha256 digest" >&2; exit 1
fi
source_digest=$WORKSPACE_IMAGE
image="halo-workspace:${source_digest##*:}"
case "$mode" in
  template) vm=${EXE_TEMPLATE_VM_NAME:?} ;;
  update) vm=${INSTANCE:?} ;;
  *) echo "Mode must be template or update" >&2; exit 1 ;;
esac
diagnostics="$RUNNER_TEMP/exe-rollout/$vm"
mkdir -p "$diagnostics"
phase=starting
started=$SECONDS
write_status() {
  jq -n --arg phase "$phase" --arg vm "$vm" --arg version "$VERSION" \
    --arg revision "$SOURCE_SHA" --arg image "$source_digest" \
    --arg state "$1" --argjson exitCode "$2" --argjson elapsed "$(( SECONDS - started ))" \
    '{state:$state,phase:$phase,vm:$vm,version:$version,expectedRevision:$revision,image:$image,exitCode:$exitCode,elapsedSeconds:$elapsed}' > "$diagnostics/status.json"
}
report_phase() {
  phase=$1
  write_status running null
  echo "HALO_ROLLOUT phase=$phase vm=$vm version=$VERSION revision=$SOURCE_SHA image=$source_digest elapsed=$(( SECONDS - started ))s"
}
export DOCKER_CONFIG
DOCKER_CONFIG=$(mktemp -d "$RUNNER_TEMP/exe-registry.XXXXXX")
restore_paused=false
clean_images_on_exit=false
restore_sleep_on_exit() {
  result=$?
  trap - EXIT
  rm -rf "$DOCKER_CONFIG"
  # A failed update must not leave its image behind to fill the next attempt's disk.
  if [ "$clean_images_on_exit" = true ]; then remove_unused_images; fi
  if [ "$restore_paused" = true ]; then
    if ! timeout --kill-after=5s 30s ssh "${ssh_args[@]}" exe.dev pause "$vm"; then
      echo "Failed to restore $vm to its paused state" >&2
      result=1
    fi
  fi
  write_status finished "$result"
  if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
    # Backticks are literal Markdown, not shell command substitutions.
    # shellcheck disable=SC2016
    printf '### Exe rollout: %s\n\nVersion: `%s` · expected source: `%s`\n\nImage: `%s`\n\nLast phase: **%s** · exit: **%s** · elapsed: %ss\n\nSee the `exe-rollout` artifact for this VM and the job log for layer progress. Retry failed jobs in the original run to reuse the release artifacts.\n' \
      "$vm" "$VERSION" "$SOURCE_SHA" "$source_digest" "$phase" "$result" "$(( SECONDS - started ))" >> "$GITHUB_STEP_SUMMARY"
  fi
  exit "$result"
}
trap restore_sleep_on_exit EXIT
trap 'exit 143' TERM HUP
trap 'exit 130' INT
report_phase registry-metadata
timeout --kill-after=5s 30s gcloud auth print-access-token |
  timeout --kill-after=5s 30s docker login -u oauth2accesstoken --password-stdin "${source_digest%%/*}"

# Keep only the image the halo service is configured to run and any image a
# container uses; everything else is an earlier release or a failed install.
remove_unused_images() {
  timeout --kill-after=5s 60s ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo timeout --kill-after=5s 55s bash -s' <<'CLEAN' || echo "Could not remove unused workspace images on $vm" >&2
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

# Retry only the idempotent image transfer. Each attempt gets fresh credentials
# and a guest-side deadline; the SSH deadline is longer so remote cleanup can
# finish first. Cached layers are reused without restarting workspace services.
pull_on_guest() {
  report_phase pull-image
  local remote token attempt token_attempt result diagnostic_command
  remote=$(cat "$root/infra/workspace/exePull.sh")
  for attempt in 1 2; do
    echo "HALO_PULL_ATTEMPT vm=$vm attempt=$attempt/2 deadline=900s image=$source_digest"
    # A new token-creator grant can take a few minutes to propagate.
    for token_attempt in $(seq 1 12); do
      if token=$(timeout --kill-after=5s 15s gcloud auth print-access-token --impersonate-service-account="$image_puller" --lifetime=1800); then break; fi
      if [ "$token_attempt" = 12 ]; then echo "Could not mint a pull token for $image_puller" >&2; return 1; fi
      sleep 10
    done
    result=0
    printf '%s\n' "$token" |
      timeout --kill-after=15s 990s ssh "${ssh_args[@]}" "$vm.exe.xyz" \
        "sudo timeout --kill-after=15s 900s bash -c $(printf %q "$remote") pull $(printf %q "${source_digest%%/*}") $(printf %q "$source_digest") $(printf %q "$image")" || result=$?
    unset token
    if [ "$result" = 0 ]; then return; fi
    echo "HALO_PULL_FAILED vm=$vm attempt=$attempt exit=$result (124 means deadline exceeded)" >&2
    # Evidence is bounded too; never collect registry credentials or inspect
    # container environment variables into a public CI artifact.
    diagnostic_command='date -u; df -h /var/lib/docker; docker image ls --digests; journalctl -u docker --since "-20 min" -n 100 --no-pager'
    timeout --kill-after=5s 45s ssh "${ssh_args[@]}" "$vm.exe.xyz" \
      "sudo timeout --kill-after=5s 30s bash -c $(printf %q "$diagnostic_command")" \
      2>&1 | tee "$diagnostics/pull-attempt-$attempt.log" || true
  done
  return "$result"
}

# Bytes a guest needs to pull and unpack this image if it has none of its
# layers: containerd keeps the compressed layers, and unpacked they measured
# about 2.7 times larger (1.4 GB to 3.8 GB), so 4 times the compressed size,
# plus 1 GiB.
update_bytes() {
  local manifest digest
  manifest=$(timeout --kill-after=5s 60s docker buildx imagetools inspect --raw "$source_digest")
  if jq -e '.manifests' <<< "$manifest" >/dev/null; then
    digest=$(jq -er '[.manifests[] | select(.platform.os == "linux" and .platform.architecture == "amd64")][0].digest' <<< "$manifest")
    manifest=$(timeout --kill-after=5s 60s docker buildx imagetools inspect --raw "${source_digest%@*}@$digest")
  fi
  echo $(( $(jq '[.layers[].size] | add' <<< "$manifest") * 4 + 1073741824 ))
}

# Space root can still write where Docker keeps its data. Docker runs as root,
# so it may use the update reserve that user files cannot.
guest_root_free_bytes() {
  ssh "${ssh_args[@]}" "$vm.exe.xyz" "stat -f -c '%f %S' /var/lib" | awk '{ print $1 * $2 }'
}

# A full disk also stops the running workspace, so refuse the transfer when the
# guest lacks room to pull and unpack the image.
require_free_space() {
  local needed free
  needed=$(update_bytes)
  free=$(guest_root_free_bytes)
  if [ "$free" -lt "$needed" ]; then
    echo "$vm has $(( free / 1048576 ))MiB free but needs $(( needed / 1048576 ))MiB to pull $image; leaving the running workspace unchanged" >&2
    exit 1
  fi
}

# Keep the next update's space for root with ext4's reserved blocks, so user
# files, written by the non-root workspace user, cannot fill it. The reserve
# is sized for this release and left at 1 GiB short of the free space when the
# guest is already fuller, so users are never blocked from writing outright.
set_update_reserve() {
  local reserve free block cap
  reserve=$(update_bytes)
  free=$(guest_root_free_bytes)
  block=$(ssh "${ssh_args[@]}" "$vm.exe.xyz" "stat -f -c '%S' /var/lib")
  cap=$(( free - 1073741824 ))
  if [ "$cap" -lt "$reserve" ]; then
    echo "$vm has only $(( free / 1048576 ))MiB free; reserving $(( cap > 0 ? cap / 1048576 : 0 ))MiB of the $(( reserve / 1048576 ))MiB the next update needs" >&2
    reserve=$(( cap > 0 ? cap : 0 ))
  fi
  # The workspace already runs the new release here, so a reserve failure only
  # warns, like the image cleanup. Verified on an exe.dev guest: /var/lib is on
  # /dev/vda (ext4).
  ssh "${ssh_args[@]}" "$vm.exe.xyz" "dev=\$(findmnt -no SOURCE --target /var/lib) && test -b \"\$dev\" && sudo tune2fs -r $(( reserve / block )) \"\$dev\" >/dev/null" ||
    echo "Could not set the update reserve on $vm" >&2
}

case "$mode" in
  template)
    restore_paused=true
    report_phase inspect-template
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
      report_phase bootstrap-template
      ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo test ! -f /etc/halo/assignment.json && { sudo test ! -d /var/lib/halo/home || sudo test -z "$(sudo find /var/lib/halo/home -type f -print -quit)"; }'
      ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo date -s '@$(date +%s)' >/dev/null; sudo apt-get update >/dev/null && sudo apt-get install -y docker.io >/dev/null && sudo systemctl enable --now docker"
      pull_on_guest
      report_phase install-template
      scp "${ssh_args[@]}" "$root/infra/workspace/exeTemplate.sh" "$root/infra/workspace/appSandboxSetup.sh" "$root/infra/workspace/appHost.py" "$root/infra/workspace/appPaths.py" "$root/infra/workspace/desktop-seccomp.json" "$vm.exe.xyz:/tmp/"
      ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo bash /tmp/exeTemplate.sh '$image'"
    fi
    report_phase verify-template
    ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo test ! -f /etc/halo/assignment.json && sudo test ! -f /etc/halo/workspace-server.json && sudo test -z "$(sudo find /var/lib/halo/home -type f -print -quit)" && sudo test ! -f /root/.docker/config.json && sudo test ! -f /home/exedev/.docker/config.json && sudo sync'
    # Workspaces are copies of the template, so they start with this reserve.
    report_phase reserve-disk
    set_update_reserve
    ssh "${ssh_args[@]}" "$vm.exe.xyz" "printf '%s\\n' '$image' | sudo tee /etc/halo/template-ready >/dev/null; sudo sync"
    report_phase pause-template
    ssh "${ssh_args[@]}" exe.dev pause "$vm"
    restore_paused=false
    report_phase ready
    echo "HALO_EXE_TEMPLATE_READY name=$vm image=$image"
    ;;
  update)
    report_phase inspect-workspace
    status=$(ssh "${ssh_args[@]}" exe.dev ls "$vm" --json | jq -er '.vms[0].status')
    if [ "$status" = paused ] || [ "$status" = suspended ]; then
      restore_paused=true
      ssh "${ssh_args[@]}" exe.dev resume "$vm"
      # A RAM restore keeps the guest clock from when it paused; apt rejects
      # package indexes "not valid yet" until the clock is corrected.
      for attempt in 1 2 3 4 5; do
        ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo date -s '@$(date +%s)' >/dev/null" && break
        [ "$attempt" = 5 ] && exit 1
        sleep 3
      done
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
    report_phase check-disk
    clean_images_on_exit=true
    remove_unused_images
    require_free_space
    pull_on_guest
    report_phase install-workspace
    scp "${ssh_args[@]}" "$root/infra/workspace/exeTemplate.sh" "$root/infra/workspace/appSandboxSetup.sh" "$root/infra/workspace/appHost.py" "$root/infra/workspace/appPaths.py" "$root/infra/workspace/desktop-seccomp.json" "$vm.exe.xyz:/tmp/"
    ssh "${ssh_args[@]}" "$vm.exe.xyz" "sudo bash /tmp/exeTemplate.sh '$image' update-host && sudo /usr/local/bin/halo-workspace-upgrade '$image'"
    report_phase verify-workspace
    ready=false
    for attempt in $(seq 1 60); do
      if info=$(ssh "${ssh_args[@]}" "$vm.exe.xyz" 'sudo docker exec halo-workspace node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json' 2> "$RUNNER_TEMP/exe-status-error.log"); then
        # Diagnostics must not turn a transient invalid response into a failed
        # readiness gate; retain the last valid identity while retries continue.
        if jq '{build,protocolVersion,supportedProtocols}' <<< "$info" > "$diagnostics/observed-workspace.tmp"; then
          mv "$diagnostics/observed-workspace.tmp" "$diagnostics/observed-workspace.json"
        else
          rm -f "$diagnostics/observed-workspace.tmp"
        fi
        if jq -e --arg revision "$SOURCE_SHA" --argjson protocols "$(jq -c .protocols.workspace.supported "$release_manifest")" '.build.revision == $revision and (.supportedProtocols // [.protocolVersion]) == $protocols' <<< "$info" >/dev/null; then ready=true; break; fi
      fi
      sleep 5
    done
    if [ "$ready" != true ]; then cat "$RUNNER_TEMP/exe-status-error.log" >&2; echo "$vm did not become ready for $image" >&2; exit 1; fi
    # Cleanup must run while the guest is awake, before it is paused again.
    clean_images_on_exit=false
    remove_unused_images
    report_phase reserve-disk
    set_update_reserve
    if [ "$status" = paused ] || [ "$status" = suspended ]; then
      report_phase pause-workspace
      ssh "${ssh_args[@]}" exe.dev pause "$vm"
    fi
    restore_paused=false
    report_phase ready
    echo "HALO_WORKSPACE_READY image=$image revision=$SOURCE_SHA"
    ;;
  *) echo "Mode must be template or update" >&2; exit 1 ;;
esac
