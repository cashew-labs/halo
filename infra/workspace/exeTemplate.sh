#!/usr/bin/env bash
# Prepare an EMPTY Exe VM for cloning. Run as root with a prebuilt workspace image.
set -euo pipefail
image=${1:?Usage: exeTemplate.sh IMAGE}

apt-get update
apt-get install -y docker.io python3
systemctl enable --now docker
if ! docker image inspect "$image" >/dev/null 2>&1; then docker pull "$image"; fi
mkdir -p /etc/halo /var/lib/halo/home/documents
chown -R 1000:1000 /var/lib/halo/home

script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
cp "$script_dir/desktop-seccomp.json" /etc/halo/desktop-seccomp.json
docker run --rm --entrypoint cat "$image" /opt/halo/apps/workspace-server/container.json \
  > /etc/halo/workspace-server-base.json
printf '%s\n' "$image" > /etc/halo/image

cat > /usr/local/bin/halo-workspace-assign <<'ASSIGN'
#!/usr/bin/env python3
import base64, fcntl, json, os, pathlib, subprocess, sys

# Serialize assignment across control-plane processes. Never overwrite an owner.
with open('/run/halo-workspace-assign.lock', 'w') as lock:
    fcntl.flock(lock, fcntl.LOCK_EX)
    encoded = sys.argv[1]
    assignment = json.loads(base64.urlsafe_b64decode(encoded + '=' * (-len(encoded) % 4)))
    path = pathlib.Path('/etc/halo/assignment.json')
    if path.exists() and json.loads(path.read_text()) != assignment:
        sys.exit('Workspace is already assigned to another identity or credential')
    if not path.exists():
        config = json.loads(pathlib.Path('/etc/halo/workspace-server-base.json').read_text())
        config['ownerUserId'] = assignment['ownerUserId']
        config['gateway'] = {'token': assignment['gatewayToken']}
        config.pop('traceUpload', None)
        # Both files live outside the user-writable home and are committed atomically.
        for destination, value in [('/etc/halo/workspace-server.json', config), (str(path), assignment)]:
            temporary = destination + '.tmp'
            with open(temporary, 'w') as output:
                os.chmod(temporary, 0o600)
                json.dump(value, output)
            os.chown(temporary, 1000 if destination.endswith('workspace-server.json') else 0, 0)
            os.replace(temporary, destination)
    subprocess.run(['systemctl', 'enable', 'halo'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['systemctl', 'start', 'halo'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print('HALO_WORKSPACE_ASSIGNED')
ASSIGN
chmod 0755 /usr/local/bin/halo-workspace-assign

cat > /usr/local/bin/halo-workspace-run <<'RUN'
#!/usr/bin/env bash
set -euo pipefail
image=$(cat /etc/halo/image)
exec docker run --rm --name halo-workspace --network host --init --shm-size=1g \
  --security-opt seccomp=/etc/halo/desktop-seccomp.json \
  --env-file /etc/halo/workspace.env \
  --volume /var/lib/halo/home:/home/node \
  --volume /etc/halo/workspace-server.json:/etc/halo/workspace-server.json:ro \
  "$image" /etc/halo/workspace-server.json
RUN
chmod 0755 /usr/local/bin/halo-workspace-run
touch /etc/halo/workspace.env
chmod 0600 /etc/halo/workspace.env
cat > /etc/systemd/system/halo.service <<'SERVICE'
[Unit]
Description=Halo Exe workspace
Requires=docker.service
After=docker.service network-online.target
Wants=network-online.target
ConditionPathExists=/etc/halo/assignment.json
[Service]
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
ExecStart=/usr/local/bin/halo-workspace-run
ExecStop=/usr/bin/docker stop --time 30 halo-workspace
[Install]
WantedBy=multi-user.target
SERVICE
systemctl daemon-reload
# Assignment starts the clone; the template must never run a user workspace.
printf 'HALO_EXE_TEMPLATE_READY\n'
