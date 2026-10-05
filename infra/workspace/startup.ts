import desktopSeccomp from "./desktop-seccomp.json" with { type: "json" };

export function workspaceStartup(ctx: {
  gateway?: true;
  image: string;
  registry: string;
}) {
  const gatewayMetadata =
    ctx.gateway === undefined
      ? ""
      : `workspace_hostname=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/hostname)
gateway_service_account=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/halo-control-plane-service-account)
control_plane_origin=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/halo-control-plane-origin)
workspace_id=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/halo-workspace-id)`;
  const writeConfig =
    ctx.gateway === undefined
      ? `jq --arg owner "$owner_user_id" '.ownerUserId = $owner' /run/halo-workspace-server.json > /mnt/halo/workspace/.halo/workspace-server.json`
      : `jq --arg owner "$owner_user_id" --arg traces "$control_plane_origin" --arg workspace "$workspace_id" --arg audience "http://$workspace_hostname:8788" --arg service_account "$gateway_service_account" '.ownerUserId = $owner | .traceUpload = { origin: $traces, workspaceId: $workspace } | .gateway = { audience: $audience, serviceAccountEmail: $service_account }' /run/halo-workspace-server.json > /mnt/halo/workspace/.halo/workspace-server.json`;

  return `#!/usr/bin/env bash
set -euo pipefail

# Boot and release SSH can invoke startup together; serialize their service writes.
exec 9>/run/halo-workspace-startup.lock
flock 9

if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y docker.io curl jq
fi
systemctl enable --now docker

previous_image=$(docker inspect --format '{{.Config.Image}}' halo-workspace 2>/dev/null || true)
# Download while the old container still serves users, before changing its service.
curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | jq -r .access_token | docker login --username oauth2accesstoken --password-stdin https://${ctx.registry}
docker pull ${ctx.image}

# Docker's default filter blocks the namespaces Chrome needs for its sandbox.
mkdir -p /etc/halo
cat > /etc/halo/desktop-seccomp.json <<'SECCOMP'
${JSON.stringify(desktopSeccomp)}
SECCOMP

# A workflow retry or VM boot can reuse an already healthy release.
if [ "$(docker inspect --format '{{.Config.Image}} {{.State.Health.Status}}' halo-workspace 2>/dev/null || true)" = "${ctx.image} healthy" ] \
  && docker inspect --format '{{json .HostConfig.SecurityOpt}}' halo-workspace \
    | jq -e --slurpfile expected /etc/halo/desktop-seccomp.json \
      '(. // []) | map(select(startswith("seccomp={")) | sub("^seccomp="; "") | fromjson) | any(. == $expected[0])' >/dev/null; then
  status=$(docker exec halo-workspace node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json)
  protocols=$(jq -cer '.supportedProtocols // [.protocolVersion]' <<< "$status")
  revision=$(jq -er '.build.revision' <<< "$status")
  echo "HALO_WORKSPACE_READY image=${ctx.image} protocols=$protocols revision=$revision"
  exit 0
fi

disk=/dev/disk/by-id/google-halo-workspace
# GCP attaches new disks without a filesystem; never reformat an existing workspace.
if ! blkid "$disk" >/dev/null; then
  mkfs.ext4 -F "$disk"
fi
mkdir -p /mnt/halo
cat > /etc/systemd/system/mnt-halo.mount <<'MOUNT'
[Unit]
Description=Halo persistent workspace disk
[Mount]
What=/dev/disk/by-id/google-halo-workspace
Where=/mnt/halo
Type=ext4
[Install]
WantedBy=multi-user.target
MOUNT
systemctl daemon-reload
systemctl enable --now mnt-halo.mount
mkdir -p /mnt/halo/workspace
chown 1000:1000 /mnt/halo/workspace
mkdir -p /mnt/halo/workspace/documents
chown 1000:1000 /mnt/halo/workspace/documents

cat > /usr/local/bin/halo-workspace-config <<'CONFIG'
#!/usr/bin/env bash
set -euo pipefail

owner_user_id=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/halo-owner-user-id)
${gatewayMetadata}
workspace=/mnt/halo/workspace
documents="$workspace/documents"
mkdir -p "$workspace/.halo" "$documents/.halo"
chown 1000:1000 "$documents/.halo"

# Keep VM runtime data in the home directory; move workspace-owned state before
# the server starts with its new workspace root. This can resume after a restart.
shopt -s dotglob nullglob
for source in "$workspace/.agents" "$workspace/.pi" "$workspace/AGENTS.md" "$workspace/.halo/"*; do
  [ -e "$source" ] || [ -L "$source" ] || continue
  case "$source" in
    "$workspace/.halo/runtime"|"$workspace/.halo/workspace-server.json") continue ;;
  esac
  name=$(basename -- "$source")
  case "$source" in
    "$workspace/.halo/"*) destination="$documents/.halo/$name" ;;
    *) destination="$documents/$name" ;;
  esac
  if [ -e "$destination" ] || [ -L "$destination" ]; then
    echo "Cannot migrate $source: $destination already exists" >&2
    exit 1
  fi
  mv -- "$source" "$destination"
done

docker run --rm --entrypoint cat ${ctx.image} /opt/halo/apps/workspace-server/container.json > /run/halo-workspace-server.json
${writeConfig}
chown -R 1000:1000 /mnt/halo/workspace/.halo
CONFIG
chmod 0755 /usr/local/bin/halo-workspace-config

cat > /etc/systemd/system/halo.service <<'SERVICE'
[Unit]
Description=Halo workspace server
Requires=docker.service mnt-halo.mount
After=docker.service mnt-halo.mount network-online.target
Wants=network-online.target
[Service]
Restart=on-failure
RestartSec=5
TimeoutStartSec=600
TimeoutStopSec=45
ExecStartPre=/usr/local/bin/halo-workspace-config
ExecStart=/usr/bin/docker run --rm --name halo-workspace --network host --init --shm-size=1g --security-opt seccomp=/etc/halo/desktop-seccomp.json --volume /mnt/halo/workspace:/home/node ${ctx.image} /home/node/.halo/workspace-server.json
ExecStop=/usr/bin/docker stop --time 30 halo-workspace
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable halo
systemctl restart halo

for attempt in $(seq 1 120); do
  if health=$(docker inspect --format '{{.State.Health.Status}}' halo-workspace 2>/dev/null); then
    if [ "$health" = "healthy" ]; then
      status=$(docker exec halo-workspace node --import /opt/halo/node_modules/tsx/dist/loader.mjs /opt/halo/packages/halo-cli/src/cli.ts status --json)
      protocols=$(jq -cer '.supportedProtocols // [.protocolVersion]' <<< "$status")
      revision=$(jq -er '.build.revision // "unknown"' <<< "$status")
      # Keep the running release cached without accumulating superseded images.
      if [ -n "$previous_image" ] && [ "$previous_image" != "${ctx.image}" ]; then
        if ! docker image rm "$previous_image"; then
          echo "Could not remove superseded workspace image $previous_image" >&2
        fi
      fi
      echo "HALO_WORKSPACE_READY image=${ctx.image} protocols=$protocols revision=$revision"
      exit 0
    fi
  fi
  sleep 5
done

echo "Halo workspace did not become healthy"
exit 1
`;
}
