#!/usr/bin/env bash
set -euo pipefail

desktop_dir=/opt/halo/apps/workspace-server/desktop
export XDG_RUNTIME_DIR=/tmp/halo-desktop-runtime
mkdir -p "$XDG_RUNTIME_DIR" "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml" \
  "$HOME/.config/xfce4/panel" "$HOME/.config/halo-chrome/Default"
chmod 700 "$XDG_RUNTIME_DIR"
if [[ ! -f "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml" ]]; then
  cp "$desktop_dir/panel.xml" "$HOME/.config/xfce4/xfconf/xfce-perchannel-xml/xfce4-panel.xml"
fi
for launcher in 1 2 3; do
  mkdir -p "$HOME/.config/xfce4/panel/launcher-$launcher"
  cp "$desktop_dir/launcher-$launcher.desktop" "$HOME/.config/xfce4/panel/launcher-$launcher/"
done
if [[ ! -f "$HOME/.config/halo-chrome/Default/Preferences" ]]; then
  printf '%s\n' '{"download":{"default_directory":"/home/node/documents"}}' \
    > "$HOME/.config/halo-chrome/Default/Preferences"
fi

desktop_pids=()
cleanup() {
  trap - EXIT TERM INT
  kill "${desktop_pids[@]}" 2>/dev/null || true
  wait || true
}
trap cleanup EXIT
trap 'exit 0' TERM INT

Xtigervnc "$DISPLAY" -geometry 1280x800 -depth 24 -localhost \
  -SecurityTypes None -AlwaysShared -AcceptSetDesktopSize -nolisten tcp &
desktop_pids+=("$!")
for attempt in {1..100}; do
  if xdpyinfo >/dev/null 2>&1; then break; fi
  kill -0 "${desktop_pids[0]}"
  sleep 0.1
done
xdpyinfo >/dev/null
xsetroot -solid '#20242b'
xfwm4 --compositor=off &
desktop_pids+=("$!")
xfsettingsd --no-daemon &
desktop_pids+=("$!")
xfce4-panel --disable-wm-check &
desktop_pids+=("$!")
# Reopen the user's saved browser after container maintenance or a provider move.
# Chrome is a user application: closing it must not stop the desktop service.
if compgen -G "$HOME/.config/halo-chrome/Default/Sessions/Session_*" >/dev/null; then
  bash "$desktop_dir/chrome.sh" &
fi
/usr/bin/websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901 &
desktop_pids+=("$!")
node --import /opt/halo/node_modules/tsx/dist/loader.mjs \
  /opt/halo/apps/workspace-server/src/main.ts "$@" &
desktop_pids+=("$!")

# A failed desktop or workspace process fails the container so its owner can restart it.
wait -n "${desktop_pids[@]}"
exit 1
