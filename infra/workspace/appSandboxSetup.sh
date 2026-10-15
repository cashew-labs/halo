#!/usr/bin/env bash
set -euo pipefail
app_image=${1:?Usage: appSandboxSetup.sh WORKSPACE_IMAGE}
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
# The signed Debian package includes runsc's sidecar binaries.
apt-get update
apt-get install -y ca-certificates curl gnupg e2fsprogs iptables
curl -fsSL https://gvisor.dev/archive.key \
  | gpg --batch --yes --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
printf 'deb [arch=%s signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main\n' \
  "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/gvisor.list
apt-get update
apt-get install -y runsc
python3 - <<'DOCKER'
import json, pathlib
path = pathlib.Path('/etc/docker/daemon.json')
config = json.loads(path.read_text()) if path.exists() else {}
config.setdefault('runtimes', {})['runsc'] = {'path': '/usr/bin/runsc', 'runtimeArgs': ['--platform=systrap']}
path.write_text(json.dumps(config))
DOCKER
systemctl reload docker
docker pull node:24.21.0-bookworm-slim
cat > /usr/local/bin/halo-app-network <<'NETWORK'
#!/usr/bin/env bash
set -euo pipefail
iptables -I INPUT 1 -s 172.30.0.0/24 -j DROP
iptables -I DOCKER-USER 1 -s 172.30.0.0/24 -j DROP
if ! docker network inspect halo-apps >/dev/null 2>&1; then
  docker network create --subnet 172.30.0.0/24 --gateway 172.30.0.1 \
    --opt com.docker.network.bridge.enable_icc=false halo-apps
fi
# Keep per-app broker ACCEPT rules across supervisor restarts and host updates;
# the supervisor inserts them above these two fixed rules.
iptables -N HALO-APPS-HOST 2>/dev/null || true
iptables -C HALO-APPS-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT 2>/dev/null \
  || iptables -A HALO-APPS-HOST -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -C HALO-APPS-HOST -j DROP 2>/dev/null || iptables -A HALO-APPS-HOST -j DROP
iptables -C INPUT -s 172.30.0.0/24 -j HALO-APPS-HOST 2>/dev/null \
  || iptables -I INPUT 1 -s 172.30.0.0/24 -j HALO-APPS-HOST
iptables -N HALO-APPS-OUT 2>/dev/null || true
iptables -F HALO-APPS-OUT
for destination in 0.0.0.0/8 10.0.0.0/8 100.64.0.0/10 127.0.0.0/8 \
  169.254.0.0/16 172.16.0.0/12 192.0.0.0/24 192.168.0.0/16 \
  198.18.0.0/15 224.0.0.0/4 240.0.0.0/4; do
  iptables -A HALO-APPS-OUT -d "$destination" -j REJECT
done
iptables -A HALO-APPS-OUT -j RETURN
iptables -C DOCKER-USER -s 172.30.0.0/24 -j HALO-APPS-OUT 2>/dev/null \
  || iptables -I DOCKER-USER 1 -s 172.30.0.0/24 -j HALO-APPS-OUT
iptables -D INPUT -s 172.30.0.0/24 -j DROP
iptables -D DOCKER-USER -s 172.30.0.0/24 -j DROP
NETWORK
chmod 0755 /usr/local/bin/halo-app-network
/usr/local/bin/halo-app-network
mkdir -p /var/lib/halo/apps /var/lib/halo/app-sdk /run/halo-apps
packer="halo-app-sdk-packer-$$"
trap 'docker rm -f "$packer" >/dev/null 2>&1 || true' EXIT
docker run --name "$packer" --network none --entrypoint bash "$app_image" -c \
  'mkdir -p /tmp/sdk && npm pack --ignore-scripts --pack-destination /tmp/sdk /opt/halo/packages/extension-sdk /opt/halo/packages/extension-tools &&
   mv /tmp/sdk/get-halo-extension-sdk-*.tgz /tmp/sdk/get-halo-extension-sdk.tgz &&
   mv /tmp/sdk/get-halo-extension-tools-*.tgz /tmp/sdk/get-halo-extension-tools.tgz'
docker cp "$packer:/tmp/sdk/." /var/lib/halo/app-sdk/
docker rm "$packer" >/dev/null
trap - EXIT
chmod 0750 /run/halo-apps
chown root:1000 /run/halo-apps
install -m 0755 "$script_dir/appHost.py" /usr/local/bin/halo-app-host
install -m 0644 "$script_dir/appPaths.py" /usr/local/bin/appPaths.py
cat > /etc/systemd/system/halo-apps.slice <<'SLICE'
[Unit]
Description=Aggregate Halo app and build limits
[Slice]
CPUQuota=100%
MemoryMax=512M
TasksMax=256
SLICE
cat > /etc/systemd/system/halo-app-host.service <<'APPHOST'
[Unit]
Description=Halo app sandbox supervisor
Requires=docker.service halo-apps.slice
After=docker.service halo-apps.slice network-online.target
[Service]
ExecStartPre=/usr/local/bin/halo-app-network
ExecStart=/usr/local/bin/halo-app-host
Restart=on-failure
RuntimeDirectory=halo-apps
RuntimeDirectoryMode=0750
RuntimeDirectoryPreserve=yes
MemoryMax=128M
[Install]
WantedBy=multi-user.target
APPHOST
systemctl daemon-reload
systemctl enable halo-app-host
systemctl restart halo-app-host
