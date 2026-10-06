#!/usr/bin/env bash
# Copy a stopped GCP workspace into an unassigned Exe clone. Do not switch providers.
set -euo pipefail
: "${PROJECT:?}" "${ZONE:?}" "${INSTANCE:?}" "${EXE_TEMPLATE_VM_NAME:?}" "${EXE_PRIVATE_KEY_PATH:?}" "${EXE_WORKSPACE_TAG:?}" "${RUNNER_TEMP:?}"
if [[ ! "$INSTANCE" =~ ^halo-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]]; then
  echo 'Expected a Halo workspace VM name' >&2; exit 1
fi
root=$(cd -- "$(dirname -- "$0")/../.." && pwd)
mkdir -p "$RUNNER_TEMP"
chmod 700 "$RUNNER_TEMP"
ssh_args=(-F /dev/null -i "$EXE_PRIVATE_KEY_PATH" -o IdentitiesOnly=yes -o IdentityAgent=none
  -o BatchMode=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$root/infra/workspace/exe-known-hosts"
  -o ConnectTimeout=10 -o ServerAliveInterval=30 -o ServerAliveCountMax=10)
gcp_ssh=(--project="$PROJECT" --zone="$ZONE" --tunnel-through-iap --quiet
  --ssh-flag=-oConnectTimeout=10 --ssh-flag=-oServerAliveInterval=30 --ssh-flag=-oServerAliveCountMax=10)
details=$(gcloud compute instances describe "$INSTANCE" --project="$PROJECT" --zone="$ZONE" --format=json)
workspace_id="${INSTANCE#halo-}"
if [ "$(jq -er '.metadata.items[] | select(.key == "halo-workspace-id") | .value' <<< "$details")" != "$workspace_id" ]; then
  echo 'Source workspace identity does not match its VM name' >&2; exit 1
fi
disk=$(jq -er '[.disks[] | select(.deviceName == "halo-workspace" and .boot == false) | .source | split("/")[-1]] | if length == 1 then .[0] else error("Expected one workspace disk") end' <<< "$details")
if [ "$disk" != "$INSTANCE-workspace" ]; then echo 'Unexpected source data disk' >&2; exit 1; fi
# Refuse retries onto a possibly assigned/user-modified destination. Retained archives
# and source snapshots are the recovery surface for interrupted migrations.
if [ "$(ssh "${ssh_args[@]}" exe.dev ls "$INSTANCE" --json | jq '.vms | length')" != 0 ]; then
  echo 'Destination already exists; inspect it before retrying' >&2; exit 1
fi
ssh "${ssh_args[@]}" exe.dev cp "$EXE_TEMPLATE_VM_NAME" "$INSTANCE" --copy-tags=false --json
ssh "${ssh_args[@]}" "$INSTANCE.exe.xyz" 'sudo test ! -f /etc/halo/assignment.json && sudo test -z "$(sudo find /var/lib/halo/home -mindepth 1 ! -path /var/lib/halo/home/documents -print -quit)"'
source_stopped=false
completed=false
restore_on_failure() {
  result=$?
  trap - EXIT
  if [ "$source_stopped" = true ] && [ "$completed" != true ]; then
    # Reopening the source invalidates every copy, including an interrupted final tag step.
    if ssh "${ssh_args[@]}" exe.dev tag -d "$INSTANCE" "$EXE_WORKSPACE_TAG-migrated" "$EXE_WORKSPACE_TAG-assigned" &&
      gcloud compute ssh "$INSTANCE" "${gcp_ssh[@]}" --command='sudo rm -f /var/lib/halo/exe-migration-stopped && sudo systemctl start halo'; then
      echo 'Source restarted; destination copy is no longer eligible for cutover' >&2
    else
      echo 'Could not invalidate the copy and restart its source; inspect both VMs before recovery' >&2
      result=1
    fi
  fi
  exit "$result"
}
trap restore_on_failure EXIT
gcloud compute ssh "$INSTANCE" "${gcp_ssh[@]}" --command='sudo test ! -f /mnt/halo/workspace/.halo/state.db'
source_stopped=true
# Old images lack ordered desktop shutdown; close Chrome using the same current helper.
gcloud compute ssh "$INSTANCE" "${gcp_ssh[@]}" --command='sudo docker exec -i halo-workspace bash -s' < "$root/apps/workspace-server/desktop/stop-chrome.sh"
# Invalidate this checkpoint on every service start. Systemd can unload stopped
# units and forget their timestamps, so timestamps cannot prove copy freshness.
gcloud compute ssh "$INSTANCE" "${gcp_ssh[@]}" --command='sudo bash -s' <<'CHECKPOINT'
set -euo pipefail
mkdir -p /var/lib/halo /etc/systemd/system/halo.service.d
cat > /etc/systemd/system/halo.service.d/exe-migration.conf <<'UNIT'
[Service]
ExecStartPre=/usr/bin/rm -f /var/lib/halo/exe-migration-stopped
UNIT
systemctl daemon-reload
cat /proc/sys/kernel/random/boot_id > /var/lib/halo/exe-migration-stopped
chmod 600 /var/lib/halo/exe-migration-stopped
# Write the checkpoint before stopping: a start racing with stop must remove it,
# rather than being followed by a newly written, apparently valid checkpoint.
systemctl stop halo
sync
test "$(systemctl show halo -p ActiveState --value)" = inactive
CHECKPOINT

snapshot="${INSTANCE}-exe-$(date -u +%Y%m%d%H%M%S)"
gcloud compute disks snapshot "$disk" --project="$PROJECT" --zone="$ZONE" --snapshot-names="$snapshot" --quiet
archive="$RUNNER_TEMP/$INSTANCE-home.tar.gz"
# Preserve user files/state/profile; omit old machine connections, locks, shared
# cloud credentials, and integration secrets that this deployment no longer uses.
gcloud compute ssh "$INSTANCE" "${gcp_ssh[@]}" --command="sudo tar --owner=1000 --group=1000 --numeric-owner --exclude='./.config/gcloud' --exclude='./.docker' --exclude='./.ssh' --exclude='./.halo/runtime' --exclude='./.halo/workspace-server.json' --exclude='./.halo/rpc.json' --exclude='./.halo/server.json' --exclude='./documents/.halo/runtime' --exclude='*/.halo/executor/credentials' --exclude='./.config/halo-chrome/Singleton*' -C /mnt/halo/workspace -czf - ." > "$archive"
chmod 600 "$archive"
checksum=$(shasum -a 256 "$archive" | cut -d ' ' -f 1)
# Extract as the workspace user inside an isolated read-only container, rather
# than trusting user-controlled archive names/symlinks in a root host process.
ssh "${ssh_args[@]}" "$INSTANCE.exe.xyz" 'sudo mkdir -m 700 /var/lib/halo/migration; sudo sh -c "cat > /var/lib/halo/migration/home.tar.gz"; sudo chown 1000:1000 /var/lib/halo/migration/home.tar.gz; sudo chmod 400 /var/lib/halo/migration/home.tar.gz' < "$archive"
remote_checksum=$(ssh "${ssh_args[@]}" "$INSTANCE.exe.xyz" 'sudo sha256sum /var/lib/halo/migration/home.tar.gz' | cut -d ' ' -f 1)
if [ "$checksum" != "$remote_checksum" ]; then echo 'Archive checksum mismatch' >&2; exit 1; fi
ssh "${ssh_args[@]}" "$INSTANCE.exe.xyz" 'sudo bash -s' <<'RESTORE'
set -euo pipefail
test ! -f /etc/halo/assignment.json
mkdir -m 700 /var/lib/halo/migration/home
chown 1000:1000 /var/lib/halo/migration/home
image=$(cat /etc/halo/image)
args=(--rm --network none --read-only --user 1000:1000 --cap-drop ALL --security-opt no-new-privileges
  --volume /var/lib/halo/migration/home.tar.gz:/backup.tar.gz:ro
  --volume /var/lib/halo/migration/home:/restore --workdir /restore --entrypoint /bin/tar)
docker run "${args[@]}" "$image" -xzpf /backup.tar.gz --no-same-owner
docker run "${args[@]}" "$image" -dzf /backup.tar.gz
mv /var/lib/halo/home /var/lib/halo/migration/empty-home
mv /var/lib/halo/migration/home /var/lib/halo/home
sync
RESTORE
ssh "${ssh_args[@]}" exe.dev pause "$INSTANCE"
ssh "${ssh_args[@]}" exe.dev tag "$INSTANCE" "$EXE_WORKSPACE_TAG"
ssh "${ssh_args[@]}" exe.dev tag "$INSTANCE" "$EXE_WORKSPACE_TAG-migrated"
completed=true
echo "HALO_WORKSPACE_COPIED vm=$INSTANCE snapshot=$snapshot sha256=$checksum"
echo 'Source must remain stopped until cutover. Assign the destination through WorkspaceService before deploying Exe.'
echo "To abort: remove $EXE_WORKSPACE_TAG-migrated and $EXE_WORKSPACE_TAG-assigned from $INSTANCE before restarting its GCP source. A resumed source requires a fresh copy."
