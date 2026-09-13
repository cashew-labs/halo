export function workspaceStartup(ctx: {
  gateway?: true;
  image: string;
  registry: string;
}) {
  const gatewayMetadata =
    ctx.gateway === undefined
      ? ""
      : `workspace_hostname=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/hostname)
gateway_service_account=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/halo-control-plane-service-account)`;
  const writeConfig =
    ctx.gateway === undefined
      ? `jq --arg owner "$owner_user_id" '.ownerUserId = $owner' /run/halo-workspace-server.json > /mnt/halo/workspace/.halo/workspace-server.json`
      : `jq --arg owner "$owner_user_id" --arg audience "http://$workspace_hostname:8788" --arg service_account "$gateway_service_account" '.ownerUserId = $owner | .gateway = { audience: $audience, serviceAccountEmail: $service_account }' /run/halo-workspace-server.json > /mnt/halo/workspace/.halo/workspace-server.json`;

  return `#!/usr/bin/env bash
set -euo pipefail

if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y docker.io curl jq
fi
systemctl enable --now docker

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

cat > /usr/local/bin/halo-workspace-pull <<'PULL'
#!/usr/bin/env bash
set -euo pipefail

curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token | jq -r .access_token | docker login --username oauth2accesstoken --password-stdin https://${ctx.registry}
docker pull ${ctx.image}
PULL
chmod 0755 /usr/local/bin/halo-workspace-pull

cat > /usr/local/bin/halo-workspace-config <<'CONFIG'
#!/usr/bin/env bash
set -euo pipefail

owner_user_id=$(curl -fsS -H "Metadata-Flavor: Google" http://metadata.google.internal/computeMetadata/v1/instance/attributes/halo-owner-user-id)
${gatewayMetadata}
mkdir -p /mnt/halo/workspace/.halo
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
ExecStartPre=/usr/local/bin/halo-workspace-pull
ExecStartPre=/usr/local/bin/halo-workspace-config
ExecStart=/usr/bin/docker run --rm --name halo-workspace --network host --init --shm-size=1g --volume /mnt/halo/workspace:/workspace ${ctx.image} /workspace/.halo/workspace-server.json
ExecStop=/usr/bin/docker stop --time 30 halo-workspace
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
systemctl enable halo
/usr/local/bin/halo-workspace-pull
systemctl restart halo
`;
}
