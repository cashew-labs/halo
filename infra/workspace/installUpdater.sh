#!/usr/bin/env bash
# Installs update scheduling without restarting a running workspace.
set -euo pipefail
script_dir=$(cd -- "$(dirname -- "$0")" && pwd)
install -d -m 0755 /usr/local/lib/halo
install -m 0644 "$script_dir/workspaceUpdate.py" /usr/local/lib/halo/workspaceUpdate.py.tmp
mv /usr/local/lib/halo/workspaceUpdate.py.tmp /usr/local/lib/halo/workspaceUpdate.py
cat > /etc/systemd/system/halo-workspace-update.service <<'SERVICE'
[Unit]
Description=Prepare and apply idle Halo workspace updates
After=network-online.target docker.service
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 /usr/local/lib/halo/workspaceUpdate.py
TimeoutStartSec=20min
SERVICE
cat > /etc/systemd/system/halo-workspace-update.timer <<'TIMER'
[Unit]
Description=Check for Halo workspace updates
[Timer]
OnBootSec=20s
OnUnitInactiveSec=15s
AccuracySec=1s
[Install]
WantedBy=timers.target
TIMER
systemctl daemon-reload
systemctl enable --now halo-workspace-update.timer
