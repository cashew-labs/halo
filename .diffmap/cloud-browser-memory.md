# Cloud browser memory

## Policy

Halo leaves idle tabs in Chrome's tab strip and lets native Memory Saver reclaim
their renderers. The approved first PR does not expire tabs, archive chats, add
settings, or replace Chrome. The seven-day deletion proposal is deferred.

```changes
e67cb7bd43e92fddd7a352a6f07cbde479d3059d
packages/workspace-server/src/browser/browserTools.ts
packages/workspace-server/src/browser/BrowserService.ts
apps/workspace-server/desktop/opensky-memory.patch
apps/workspace-server/Dockerfile
patches/playwright-core@1.62.1.patch
```

## ✅ Release idle browser attachments

**Before:** `BrowserService` retained Playwright's page debugger attachments until
Chrome or the server stopped. Chromium protects these pages from automatic discard.
Listing tabs also attached Playwright and evaluated every page's title.

**Now:** disconnect after 60 seconds with no underlying browser call running.
A new call waits for an in-flight disconnect and reconnects to the exact browser
endpoint. Snapshot refs expire on disconnect. Native discard can replace a tab's
CDP target ID, so agents must relist rather than recover identity by URL.
Inventory reads use `/json/list`, without attaching or evaluating
pages. `noDefaults` keeps Playwright from overriding the user's focus, media, and
download settings.

Inventory returns an empty list when no endpoint is published. Fetch failures,
including timeout or cancellation, return errors rather than claiming there are
no tabs. A controlled slow endpoint reproduced the old empty-success result;
the regression test now checks the error, a successful empty retry, and no endpoint.

Before accepting inventory, Halo checks `/json/version` against the exact browser
WebSocket endpoint in `DevToolsActivePort`. A missing or mismatched identity returns
`[]`; a failed verification read returns an error. Verification and inventory share
one five-second budget and caller cancellation. Neither request attaches a debugger.
A controlled server on the saved port reproduced another browser's tabs appearing
in inventory before the fix. The kept regression now rejects that identity and
accepts the same server only when its browser endpoint matches.

Chrome HTML-escapes titles in HTTP inventory. Halo decodes its five escape forms
before applying the text cap, with ampersands last so literal entity text survives.
The real browser-tool regression checks all five forms, Unicode, literal entities,
and a title whose escaped metadata exceeds the cap but whose visible text does not.

```changes
389057517ebab0fa03923eb8bb3b2cb3f2df2d9e
packages/workspace-server/src/browser/BrowserService.ts
packages/workspace-server/test/browser.test.ts
```

```changes
da092434b895bd38d4cefc1945f8bf21add380e3
packages/workspace-server/src/browser/BrowserService.ts
packages/workspace-server/test/browser.test.ts
```

```callstack
 tabs = BrowserService.tabs(input) [[389057517ebab0fa03923eb8bb3b2cb3f2df2d9e:packages/workspace-server/src/browser/BrowserService.ts#BrowserService.tabs]]
 ├── address = BrowserService.address() [[da092434b895bd38d4cefc1945f8bf21add380e3:packages/workspace-server/src/browser/BrowserService.ts#BrowserService.address]]
 ├── version = fetch(address.origin + "/json/version")
 ├── if version.webSocketDebuggerUrl differs from address.endpoint: return []
 ├── targets = fetch(address.origin + "/json/list")
 └── return page metadata with titles decoded once, then capped
```

```callstack
 result = browserTools.call(input) [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:packages/workspace-server/src/browser/browserTools.ts#browserTools]]
 └── result = BrowserService.call(input) [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:packages/workspace-server/src/browser/BrowserService.ts#BrowserService.call]]
     └── result = bounded(input) [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:packages/workspace-server/src/browser/BrowserService.ts#BrowserService.bounded]]
         ├── connection = connect(input) [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:packages/workspace-server/src/browser/BrowserService.ts#BrowserService.connect]]
         ├── result = run(signal)
         └── scheduleDisconnect() [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:packages/workspace-server/src/browser/BrowserService.ts#BrowserService.scheduleDisconnect]]
             └── disconnectIdle() [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:packages/workspace-server/src/browser/BrowserService.ts#BrowserService.disconnectIdle]]
```

```tsx
if (underlyingCallsAreRunning || isolatedContextsAreOpen) keepConnection();
else afterOneMinuteWithoutCalls(() => disconnectPlaywright());
// Native Chrome chooses whether a background tab is safe to unload.
```

Cancellation returns on the existing call budget, but does not release the idle
guard until underlying work settles. This avoids disconnecting a still-running
operation. Open isolated contexts defer idle disconnect because Playwright closes
them on transport detach. Closing their final tab allows idle release again.

Playwright 1.62.1 waits for every existing page to initialize when connecting;
discarded pages can block that wait indefinitely. The pinned dependency patch
adds `waitForPages`, defaulting to true. Only BrowserService passes false;
`noDefaults` alone still waits, preserving app-control renderer readiness.
`BrowserService.pageFor` activates the exact
requested sleeping target and waits for its page to initialize. This can foreground
that tab, but leaves unrelated sleeping tabs unloaded. No URL matching is used.

Playwright excludes uninitialized pages from `context.pages()`, so a blocked
initializer cannot bypass that activation fallback. A real Chrome CDP proxy held
`Page.enable` replies until activation: the client exposed zero pages while
blocked, and `BrowserService.call` activated the selected target once and returned
the expected content. This controlled readiness check rejected the later Bugbot
finding; it is separate from the native-discard check below.

```changes
2b38d29cc83ab3d704b5d7f8b5e40f37fc4da4fe
packages/workspace-server/src/browser/BrowserService.ts
patches/playwright-core@1.62.1.patch
```

Review caught that the initial `noDefaults` condition also changed app control.
A real Chrome CDP proxy delaying `Page.enable` reproduced the missing-page
regression. Both default readiness and explicit deferred initialization passed
after the fix. The restarted dev app's snapshot and exec commands also passed;
affected checks and the 69 browser/workspace E2Es were rerun successfully.

## ✅ Release computer-use attachments

OpenSky owns separate page debugger sessions; disconnecting Playwright alone does
not release them. The image applies a patch to its exact pinned Rust driver.
Its CDP pool checks idle connections once per second. An external connection owner
is an operation lease, including while awaiting a command. After a full minute
without a lease, unrestricted sockets close; shared existing-profile sockets
detach their page sessions while retaining the root socket, grants, and consent.

```callstack
 result = ComputerService.observe(input) [[packages/workspace-server/src/computer/ComputerService.ts#ComputerService.observe]]
 └── result = OpenSky browser operation
     └── connection = CdpPool.get / get_existing
         └── idle = PoolInner.reap_idle() [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:apps/workspace-server/desktop/opensky-memory.patch]]
             ├── if operation lease or open dialog: preserve page sessions
             ├── if shared: detach idle page sessions, retain consent
             └── otherwise: release idle socket
```

Cleanup is bounded to 32 detach commands and two seconds per pass. Failures log a
warning and retry after another idle minute. Open dialogs retain their sessions.
Detached-session events and successful cleanup clear dialog watcher bookkeeping;
the next operation registers fresh watchers.

## ✅ Enable native Memory Saver

The image installs recommended `HighEfficiencyModeEnabled=true` and
`MemorySaverModeSavings=2` policies. They apply to existing profiles without
rewriting Preferences, and users may override them in Chrome. These are native
defaults, not a fixed 30-minute timer. Maximum's ordinary inactivity threshold is
about two hours; pressure can trigger reclamation sooner. Chromium retains its
active-tab, pinned, audio, capture, edits, and other discard protections. No test-only discard override
or unconditional external discard is shipped.

## Verification and limits

- Real Google Chrome stable 156: the native PROACTIVE diagnostic discard was
  blocked while Halo attached, then succeeded after idle detach. A renderer with
  over 190,000 KiB RSS exited. The tab stayed in inventory without waking; another
  tab could be created and used; the sleeping tab reloaded through `browser.call`
  with `document.wasDiscarded=true`, its content and 192 MiB allocation restored.
  This diagnostic skips the minimum background wait, not other native safeguards.
  It does **not** prove the unattended two-hour timer has elapsed.
- The same real tool scenario passed after workspace service stop/start. A separate
  clean Chrome stop and session restore preserved a controlled tab; tools listed
  and read its content using its current target ID.
- Temporary consumer tests verified a 70-second underlying evaluation survives
  the 60-second caller budget and idle sweeps; isolated contexts survive idle and
  closing their last tab permits release.
- The final patched Rust browser suite passed: 281 tests, one ignored consent-UI
  test. Real WebSocket cases cover leases, pending commands, consent-root reuse,
  open dialogs, detached events, cleanup bounds, retries, and transport closure.
- Real `computer.createTab` and `computer.observe` calls passed, including idle
  debugger release and reuse on both driver-owned and existing-profile Chrome.
- `pnpm run check-affected`: 57 tasks passed, including 62 workspace unit tests.
- `pnpm --filter @get-halo/workspace-server test:e2e test/browser.test.ts test/workspace.test.ts`:
  71 tests passed. The kept idle regression protects tab state and non-attaching
  inventory, then verifies another action and snapshot after reconnection. The
  inventory regression distinguishes failed reads from an empty browser; a
  temporary service check also verified caller cancellation preserves its cause.
  The endpoint-identity regression rejects inventory from a reused port. Extra
  service checks covered missing/null identity, HTTP/JSON/network failures,
  caller cancellation, and timeout while verifying the endpoint.
  The final title correction reran all 57 affected tasks and all 71 E2Es; the
  escaped-title regression failed before decoding and passed after the fix.
- Playwright's bundled Chrome 151 did not release the heavy renderer in the
  diagnostic probe; reclamation evidence above applies to Google stable, which
  the cloud image installs. Docker image build is unavailable in this orb.

Open isolated contexts, other debugger clients, and protected active/heavy pages
can still prevent reclamation. This cannot guarantee that the host never runs out
of memory. The incident did not establish a particular leaking site or tab count.
Stock Chrome's restore behavior is unchanged; Helium's lazy-restore patch is not
included. Seven-day deletion and its durable ownership problem remain deferred.
The full container build and unattended two-hour timeout were not run. Hosted
Entire findings could not be read because the orb's login session expired; local
capture and GitHub checks remain separate from that hosted review limitation.

## Sources

- [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:apps/workspace-server/Dockerfile]]
- [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:apps/workspace-server/desktop/chrome-memory.json]]
- [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:apps/workspace-server/desktop/opensky-memory.patch]]
- [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:patches/playwright-core@1.62.1.patch]]
- [[e67cb7bd43e92fddd7a352a6f07cbde479d3059d:packages/workspace-server/src/browser/BrowserService.ts]]
- [Chromium discard protections](https://chromium.googlesource.com/chromium/src/+/HEAD/chrome/browser/performance_manager/policies/discard_eligibility_policy.cc)
- [Helium enables native Memory Saver](https://github.com/imputnet/helium/blob/2f81b9cafa38a95071e20de3f9cd6b0aca6d3c65/patches/helium/core/memory-saving-by-default.patch)
