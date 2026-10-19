# Desktop spike

The workspace container starts a single Xvnc display, XFCE window manager and
panel, and a private noVNC/WebSocket server. The panel launches Files, Terminal,
and headed Google Chrome. All processes share the workspace user, home directory,
display, and D-Bus session. Files, terminal working directories, and new Chrome
downloads use `/home/node/documents`.

Halo's Desktop sidebar entry embeds the live desktop at `/desktop/` (or
`/workspace/desktop/` through the control plane). Clicking the desktop gives it
keyboard control; connecting or reconnecting does not take focus from Halo.
While focused, the pane header shows **Capturing keyboard shortcuts** and an
**Unfocus Ctrl+Esc** button (**⌃Esc** on Mac) to return keyboard control to Halo without
reloading the iframe or restarting the stream. Both live in the fixed-height
header, so focus never resizes the stream. The remote display resizes with the
pane. The viewer reconnects to the same desktop
after a lost connection. Closing the pane does not close desktop applications.

The container entrypoint owns the processes for this spike. A critical child
exiting stops the container; its existing VM supervisor can restart it. Container
restart preserves the mounted home directory but loses running application state.
Suspend/resume and microVMs are outside this spike.

`HALO_DESKTOP_ORIGIN` configures the workspace server's private HTTP/WebSocket
target. The image sets it to `http://127.0.0.1:6080`. VNC and the bridge listen on
loopback only. Do not publish ports 5901 or 6080: desktop HTTP requests and stream
upgrades must pass through workspace authentication. Electron injects its token
for desktop routes; browser clients use the existing control-plane session.
Workspaces without this setting return an unavailable message.

Build with the existing workspace Dockerfile and run with the usual persistent
home mount, `--init`, and `--shm-size=1g`. The image installs Google's official
stable Chrome Debian package for its architecture (`amd64` or `arm64`). The
version is resolved when that image layer builds. Production builds pass the
release revision as a cache key, refreshing Chrome on each new release while
reusing earlier dependency layers. Headed Chrome uses its own
persistent profile at `~/.config/halo-chrome`; the existing browser service still
uses Playwright Chromium and is unchanged. The initial Chromium spike profile
is not migrated.

Chrome runs as the unprivileged workspace user with its browser sandbox enabled.
The launcher deliberately has no fallback to `--no-sandbox`: an incompatible
runtime must fail visibly. The runtime must support Chrome's Linux sandbox;
verify `chrome://sandbox` on each deployment environment. Do not disable container
isolation or grant broad privileges to work around a sandbox startup failure.

The GCP startup script writes `/etc/halo/desktop-seccomp.json` and passes it to
Docker with `--security-opt seccomp=...`. The vendored
`infra/workspace/desktop-seccomp.json` is the Apache-2.0-licensed
[Moby 20.10.24 default profile](https://github.com/moby/moby/blob/v20.10.24/profiles/seccomp/default.json),
matching Debian 12's Docker version, with one added allow rule for `clone`,
`setns`, and `unshare`. This follows
[Playwright's browser sandbox guidance](https://playwright.dev/docs/docker#crawling-and-scraping).
It lets the non-root browser create its own namespaces while retaining Docker's
default-deny syscall policy. It adds no Linux capabilities. The permission applies
to the workspace container, not only Chrome; refresh the profile when upgrading
the host Docker policy. A previously healthy container without the profile is
restarted when startup applies this configuration.

## Keyboard and clipboard

While the desktop iframe has focus, Electron yields Halo's built-in, custom, and
menu shortcuts to it. Click **Unfocus**, press **Ctrl+Esc**, or focus another
Halo control to restore Halo shortcuts. Losing focus or disconnecting releases
tracked modifiers and cancels pending clipboard reads.
Windows reserves Ctrl+Esc for Start and may intercept it before Halo receives it;
the Unfocus button remains available.

The viewer uses application shortcuts only, with no shortcut-mode selector or
embedded footer. Mac Command shortcuts translate to Linux Control shortcuts; Windows and
Linux Control shortcuts go to the remote application. There are no terminal-specific
copy/paste mappings.

Application shortcuts include select-all, copy, cut, paste, undo/redo, save, find,
new/close tab or window, print, address bar, reload, and zoom. Mac Command+arrows
map to line/document navigation, including Shift for selection. Unsupported Mac
Command chords are consumed rather than inserting stray text into the remote app.
Ordinary typing, composition, and other remote keys remain noVNC's responsibility.

`shortcuts.js` declares the mappings. `DesktopKeyboard.js` owns shortcut dispatch,
modifier handling, and text clipboard transfer. Clipboard reads happen only on
paste; host clipboard writes happen only after an explicit remote copy or cut.
Clipboard access requires a secure context and browser permission; failures appear
as a notice over the desktop. Images/files are not bridged. OS-reserved shortcuts, and some
browser-reserved shortcuts in the browser-hosted viewer, cannot be intercepted.

Before promoting this spike, validate interaction over a deployed connection,
macOS-to-Linux shortcuts, multiple viewers resizing the same display, and desktop
failure recovery.

## Spike validation

Locally exercised the actual workspace server and desktop in one Linux container,
through both Electron and the browser control-plane gateway. Files, Terminal, and
headed Chromium launched; a file written in Terminal appeared in Halo and opened
in Chromium. Pointer input, typing, scrolling, pane resolution changes, viewer
close/reopen, and reconnect after terminating a WebSocket bridge worker worked.
Desktop HTTP and WebSocket requests rejected unauthenticated clients; an
authenticated gateway connection completed the VNC handshake.

`pnpm run check-affected` passed all 42 tasks and 84 unit tests. A local resource
snapshot with Chromium and Terminal open showed about 961 MiB and 2.7% CPU for the
whole workspace container; this is not a capacity or latency benchmark. The local
image used a cached workspace base and an isolated test configuration with no
model calls. The follow-up below validates a clean image on GCP.

The follow-up switched the desktop launcher to Google Chrome 154.0.8037.92 on
local ARM64 Linux. It launched from the panel without extra container privileges
and without `--no-sandbox`. Its `chrome://sandbox` page reported namespace, PID
namespace, network namespace, and Seccomp-BPF sandbox support (including TSYNC),
and "You are adequately sandboxed." Yama ptrace protection was unavailable in the
local kernel.

The GCP follow-up built the complete workspace Dockerfile on an isolated AMD64
Debian 12 VM (kernel 6.1.0-53-cloud-amd64, Docker 20.10.24). Chrome failed to start
with Docker's default seccomp profile. With the vendored profile above, headed
Chrome 154.0.8037.92 reported namespace, PID/network namespace, and Seccomp-BPF
with TSYNC active, plus "You are adequately sandboxed." Yama ptrace protection
was unavailable. The container remained non-privileged with no added capabilities.

Through an IAP SSH tunnel and a local control-plane gateway, Terminal input
created a file visible in Halo and readable in Chrome. Closing and reopening
the viewer preserved the desktop. Direct and gateway HTTP/WebSocket checks
rejected unauthenticated requests and accepted authenticated connections.
`pnpm run check-affected` passed all 45 tasks. The VM used an isolated workspace
server configuration without model calls or a service account. Production
control-plane routing and deployed-connection latency remain to be validated.
