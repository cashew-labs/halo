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
    previous = json.loads(path.read_text()) if path.exists() else None
    if previous is not None and any(previous.get(key) != assignment.get(key) for key in ['workspaceId', 'ownerUserId', 'gatewayToken']):
        sys.exit('Workspace is already assigned to another identity or gateway credential')
    if previous is not None and previous.get('runtime', {}).get('generation', 0) > assignment['runtime']['generation']:
        print('HALO_WORKSPACE_ASSIGNED')
        sys.exit(0)
    config = json.loads(pathlib.Path('/etc/halo/workspace-server-base.json').read_text())
    config['ownerUserId'] = assignment['ownerUserId']
    config['gateway'] = {'token': assignment['gatewayToken']}
    config['runtime'] = assignment['runtime']
    config.pop('traceUpload', None)
    config_path = pathlib.Path('/etc/halo/workspace-server.json')
    changed = previous != assignment or not config_path.exists() or json.loads(config_path.read_text()) != config
    if changed:
        # Both files live outside the user-writable home and are committed atomically.
        for destination, value in [('/etc/halo/workspace-server.json', config), (str(path), assignment)]:
            temporary = destination + '.tmp'
            with open(temporary, 'w') as output:
                os.chmod(temporary, 0o600)
                json.dump(value, output)
            os.chown(temporary, 1000 if destination.endswith('workspace-server.json') else 0, 0)
            os.replace(temporary, destination)
    subprocess.run(['systemctl', 'enable', 'halo'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    subprocess.run(['systemctl', 'restart' if changed and previous is not None else 'start', 'halo'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
cat > /usr/local/bin/halo-workspace-upgrade <<'UPGRADE'
#!/usr/bin/env bash
set -euo pipefail
image=${1:?Usage: halo-workspace-upgrade IMAGE}
exec 9>/run/halo-workspace-upgrade.lock
flock 9
# The release runner transfers the image before interrupting the workspace.
docker image inspect "$image" >/dev/null
if [ ! -f /etc/halo/assignment.json ]; then
  echo "Cannot upgrade an unassigned workspace" >&2
  exit 1
fi
docker run --rm --entrypoint cat "$image" /opt/halo/apps/workspace-server/container.json \
  > /etc/halo/workspace-server-base.json.tmp
mv /etc/halo/workspace-server-base.json.tmp /etc/halo/workspace-server-base.json
printf '%s\n' "$image" > /etc/halo/image.tmp
mv /etc/halo/image.tmp /etc/halo/image
assignment=$(python3 -c "import base64,pathlib; print(base64.urlsafe_b64encode(pathlib.Path('/etc/halo/assignment.json').read_bytes()).decode())")
/usr/local/bin/halo-workspace-assign "$assignment"
systemctl restart halo
UPGRADE
chmod 0755 /usr/local/bin/halo-workspace-upgrade

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
# Clones boot from disk; flush preparation writes before pausing the template.
sync
# Assignment starts the clone; the template must never run a user workspace.
printf 'HALO_EXE_TEMPLATE_READY\n'
