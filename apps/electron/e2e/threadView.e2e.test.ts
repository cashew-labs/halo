import { expect, type Route } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";
import { routeWorkspaceRpc } from "./workspaceSocket.js";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import events from "node:events";
import type { AddressInfo } from "node:net";
import type { IntegrationSetup } from "@get-halo/shared/controlPlaneContract";

type IntegrationProvider = {
  origin: string;
  status: IntegrationSetup["status"];
  failCancel: boolean;
  accounts: boolean;
  setupCount: number;
  accountsReady?: Promise<unknown>;
  onAccountsRequest?: () => void;
};

const connectionTest = e2eTest.extend<{
  integrationProvider: IntegrationProvider;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright requires a destructured fixture argument.
  integrationProvider: async ({}, use) => {
    const provider: IntegrationProvider = {
      origin: "",
      status: "awaiting_credentials",
      failCancel: false,
      accounts: false,
      setupCount: 0,
    };
    // Control only the unavailable remote integration service. Electron, its
    // bridge, the workspace server, connection polling, and the card are real.
    const server = http.createServer(async (request, response) => {
      const route = new URL(request.url!, "http://provider").pathname;
      response.setHeader("content-type", "application/json");
      if (route.endsWith("/startSetup")) {
        provider.status = "awaiting_credentials";
        const setupId = `test-setup-${++provider.setupCount}`;
        response.end(
          JSON.stringify({
            json: {
              setupId,
              setupUrl: `${provider.origin}/integrations/setup/${setupId}`,
            },
          }),
        );
        return;
      }
      if (route.endsWith("/cancelSetup")) {
        if (provider.failCancel) {
          response.writeHead(503);
          response.end("Temporarily unavailable");
          return;
        }
        provider.status = "cancelled";
      }
      const accounts = provider.accounts;
      if (route.endsWith("/connections")) {
        provider.onAccountsRequest?.();
        await provider.accountsReady;
      }
      const json = route.endsWith("/setup")
        ? { status: provider.status }
        : route.endsWith("/connections")
          ? accounts
            ? [
                {
                  integration: "google_gmail",
                  name: "work",
                  address: "google_gmail.work",
                  accountLabel: "alex@acme.com",
                },
              ]
            : []
          : {};
      response.end(JSON.stringify({ json }));
    });
    server.listen({ host: "127.0.0.1", port: 0 });
    await events.once(server, "listening");
    // SAFETY: listening above guarantees a bound TCP address, not a pipe.
    provider.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      await use(provider);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  },
  workspaceRuntime: async ({ integrationProvider }, use) => {
    await use({
      origin: integrationProvider.origin,
      workspaceId: "connection-test",
      token: "test-runtime-token-for-connection-flow",
      generation: 1,
    });
  },
});

e2eTest(
  "keeps lower rows of long Markdown tables interactive while streaming and after reload",
  async ({ app, harness, llm }, testInfo) => {
    const markdown = `## Comparison table

| Engine | Conflict model | Data model | Sync scope | Offline writes | Truth |
| --- | --- | --- | --- | --- | --- |
| **Tandem** | Server reconciliation, LWW/record | Tuple/object store | Query subset (scan windows) | Yes (rebase queue) | Server |
| Replicache/Zero | Server reconciliation | Object/relational (ZQL) | Query-driven | Replicache yes; Zero read-only | Vendor server |
| Linear | Server-authoritative + OT | Object graph | Bootstrap + deltas | Yes | Linear cloud |
| InstantDB | Server reconciliation | Triples | Query subscriptions | Yes | Instant cloud |
| SQLSync | Server reconciliation | SQL | Query | Yes (rebase) | Server |
| Firestore/Convex | Server-authoritative, LWW | Document / reactive | Listeners / functions | Queue (FS) | Vendor cloud |
| Automerge | CRDT | JSON doc | Whole doc | Yes | Any peer |
| Yjs / Loro | CRDT | Rich text/any | Whole doc | Yes | Any peer |
| Ditto | CRDT | Document | Query subset | Yes (mesh) | Any peer |
| Evolu | CRDT | SQLite | Per-table/owner | Yes | Relay/peer |
| [Jazz](https://example.com/jazz) | CRDT | Relational | Partial tables/streams | Yes | Any peer |
| Triplit | CRDT (server) | Relational | Query subscriptions | Yes | Server |
| Electric | None (server) | Postgres | Shapes | No (read sync) | Your database |

## Where Tandem sits, and its edges

Tandem is squarely in Family 1, and its closest siblings are Replicache/Zero and SQLSync — same optimistic local write → push → pull → rebase on base loop, same per-client mutation IDs and lastMutationId acknowledgment, same query-scoped pull. Two things worth flagging to your friend:

- **Versus the CRDT family:** Tandem resolves conflicts as plain LWW per record, so it can't merge concurrent field edits or text the way Automerge/Yjs/Jazz/Evolu/Ditto do.
- **Server authority:** Different engines make different tradeoffs for merging data.
`;
    await harness.loadThread({
      title: "Sync engine comparison",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", {
      name: "Sync engine comparison",
    });
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Compare sync engines");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const response = await llm.stream();
    response.write(m.assistant(markdown));
    const table = pane.getByRole("table");
    await expect(table.getByRole("row")).toHaveCount(14);
    const externalUrls = await app.observeExternalUrls();
    const jazz = table.getByRole("link", { name: "Jazz", exact: true });
    await app.page.setViewportSize({ width: 1280, height: 1000 });
    // A following paragraph used to cover this row and intercept the click.
    await jazz.click();
    await expect
      .poll(async () => await externalUrls.jsonValue())
      .toEqual(["https://example.com/jazz"]);
    response.end();
    await expect(
      pane.getByRole("button", { name: "Stop", exact: true }),
    ).toHaveCount(0);
    await app.page.reload();
    for (const viewport of [
      { width: 1280, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await app.page.setViewportSize(viewport);
      await expect(table.getByRole("row")).toHaveCount(14);
      await jazz.click();
      const heading = pane.getByRole("heading", {
        name: "Where Tandem sits, and its edges",
      });
      await heading.scrollIntoViewIfNeeded();
      await expect(heading).toBeInViewport();
      await expect(
        table.getByRole("cell", { name: "Electric", exact: true }),
      ).toBeInViewport();
      await app.page.screenshot({
        path: testInfo.outputPath(
          `long-table-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
    await expect
      .poll(async () => await externalUrls.jsonValue())
      .toEqual([
        "https://example.com/jazz",
        "https://example.com/jazz",
        "https://example.com/jazz",
      ]);
  },
);

e2eTest(
  "shows one connection prompt per account when Gmail calls repeatedly require authorization",
  async ({ app, harness }, testInfo) => {
    const personal = {
      kind: "control-plane" as const,
      integration: "google_gmail",
      connectionName: "personal",
    };
    const work = { ...personal, connectionName: "work" };
    await harness.loadThread({
      title: "Daily inbox review",
      messages: [
        m.user("Review both inboxes"),
        m.assistant("Pulling mail from both accounts."),
        m.connectionRequest(personal),
        m.connectionRequest(personal),
        m.connectionRequest(personal),
        m.connectionRequest(personal),
        m.assistant("The personal account needs authorization."),
      ],
    });
    const pane = app.page.getByRole("main", { name: "Daily inbox review" });
    const cards = pane.getByRole("region", {
      name: "Gmail connection",
      exact: true,
    });
    await expect(cards).toHaveCount(1);
    await expect(
      pane.getByRole("button", { name: "Reconnect personal", exact: true }),
    ).toHaveCount(1);
    await app.page.reload();
    await expect(cards).toHaveCount(1);
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await app.page.setViewportSize(viewport);
      await app.page.screenshot({
        path: testInfo.outputPath(
          `gmail-reconnect-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await harness.loadThread({
      title: "Separate connection requests",
      messages: [
        m.user("Review both inboxes"),
        m.connectionRequest(personal),
        m.connectionRequest(personal),
        m.connectionRequest(work),
        m.assistant("Both accounts need authorization."),
        m.user("Retry the personal account"),
        m.connectionRequest(personal),
      ],
    });
    const separate = app.page.getByRole("main", {
      name: "Separate connection requests",
    });
    await expect(
      separate.getByRole("region", { name: "Gmail connection", exact: true }),
    ).toHaveCount(3);
  },
);

connectionTest(
  "recovers browser and cancellation failures without losing the pending connection",
  async ({ app, harness, integrationProvider }, testInfo) => {
    connectionTest.setTimeout(60_000);
    await harness.loadThread({
      title: "Connect Gmail",
      messages: [
        m.user("Connect my inbox"),
        m.connectionRequest({
          kind: "control-plane",
          integration: "google_gmail",
        }),
      ],
    });
    const card = app.page.getByRole("region", {
      name: "Gmail connection",
      exact: true,
    });
    const cancel = card.getByRole("button", { name: "Cancel", exact: true });
    const connect = card.getByRole("button", { name: "Connect", exact: true });
    const opened = card.getByRole("button", {
      name: "Opened in your browser",
      exact: true,
    });
    await expect(card).toContainText("No accounts connected");
    await app.page.screenshot({
      path: testInfo.outputPath("connection-empty.png"),
    });
    await app.setExternalUrlFailure(true);
    await connect.click();
    await expect(card.getByRole("alert")).toContainText(
      "Failed to open browser.",
    );
    await expect(cancel).toBeVisible();
    await expect(card).not.toContainText("No accounts connected");
    const setupLink = card.getByRole("link", { name: "Open this link" });
    await expect(setupLink).toHaveAttribute(
      "href",
      `${integrationProvider.origin}/integrations/setup/test-setup-1`,
    );
    await app.page.screenshot({
      path: testInfo.outputPath("connection-browser-failed.png"),
    });
    await app.setExternalUrlFailure(false);
    await setupLink.click();
    await expect(opened).toBeVisible();
    await expect(card.getByRole("alert")).toHaveCount(0);

    await app.setExternalUrlFailure(true);
    await opened.click();
    await expect(setupLink).toBeVisible();
    await app.setExternalUrlFailure(false);
    await card
      .getByRole("button", { name: "Open in browser", exact: true })
      .click();
    await expect(opened).toBeVisible();

    integrationProvider.failCancel = true;
    await cancel.click();
    await expect(card.getByRole("alert")).toContainText(
      "Couldn't cancel. Setup may still be active.",
    );
    await expect(cancel).toBeEnabled();
    await expect(opened).toBeVisible();
    await expect(connect).toHaveCount(0);
    await app.page.screenshot({
      path: testInfo.outputPath("connection-cancel-failed.png"),
    });
    integrationProvider.failCancel = false;
    await cancel.click();
    await expect(connect).toBeVisible();
    await expect(card.getByRole("status")).toHaveText("Cancelled");
    await connect.click();
    await expect(opened).toBeVisible();
    integrationProvider.status = "confirming";
    await expect(cancel).toBeVisible();
    await expect(card).not.toContainText("Finishing connection");
    await app.page.screenshot({
      path: testInfo.outputPath("connection-pending.png"),
    });
    const accountsReady = new events.EventEmitter();
    integrationProvider.accountsReady = events.once(accountsReady, "ready");
    integrationProvider.accounts = true;
    integrationProvider.status = "ready";
    await expect(card.getByRole("status")).toHaveText("Updating accounts…");
    await expect(card).not.toContainText("No accounts connected");
    await expect(connect).toHaveCount(0);
    await app.page.screenshot({
      path: testInfo.outputPath("connection-updating-accounts.png"),
    });
    accountsReady.emit("ready");
    integrationProvider.accountsReady = undefined;
    await expect(card.getByRole("list", { name: "Accounts" })).toContainText(
      "alex@acme.com",
    );
    const addAccount = card.getByRole("button", {
      name: "Add account",
      exact: true,
    });
    await expect(addAccount).toBeVisible();
    await app.page.screenshot({
      path: testInfo.outputPath("connection-connected.png"),
    });
    await addAccount.click();
    await expect(opened).toBeVisible();
    const cancelledAccountsReady = new events.EventEmitter();
    integrationProvider.accountsReady = events.once(
      cancelledAccountsReady,
      "ready",
    );
    await cancel.click();
    await expect(addAccount).toBeVisible();
    await expect(card).toContainText("alex@acme.com");
    await expect(card.getByRole("alert")).toHaveCount(0);
    await expect(
      card.getByText("Updating accounts…", { exact: true }),
    ).toHaveCount(0);
    cancelledAccountsReady.emit("ready");
    integrationProvider.accountsReady = undefined;

    // Accounts can change outside this card, including agent-approved removals.
    integrationProvider.accounts = false;
    await expect(card).toContainText("No accounts connected");
    await expect(card.getByRole("list", { name: "Accounts" })).toHaveCount(0);
    await expect(connect).toBeVisible();
    await expect(addAccount).toHaveCount(0);
    await expect(card.getByText("Connected", { exact: true })).toHaveCount(0);
    await app.page.screenshot({
      path: testInfo.outputPath("connection-removed.png"),
    });
    integrationProvider.accounts = true;
    await expect(card).toContainText("alex@acme.com");
    await expect(addAccount).toBeVisible();

    await harness.loadThread({
      title: "Repair Gmail",
      messages: [
        m.user("Repair work Gmail"),
        m.connectionRequest({
          kind: "control-plane",
          integration: "google_gmail",
          connectionName: "work",
        }),
      ],
    });
    const reconnect = card.getByRole("button", {
      name: "Reconnect alex@acme.com",
      exact: true,
    });
    await expect(reconnect).toBeVisible();
    await expect(
      card.getByRole("img", { name: "Reconnection required" }),
    ).toBeVisible();
    await app.page.screenshot({
      path: testInfo.outputPath("connection-repair.png"),
    });
    await reconnect.click();
    await expect(opened).toBeVisible();
    await cancel.click();
    await expect(reconnect).toBeVisible();
    await expect(card).toContainText("alex@acme.com");
    await expect(card.getByRole("status")).toHaveText("Cancelled");
  },
);

connectionTest(
  "refreshes accounts after connection completion while an older account request is pending",
  async ({ app, harness, integrationProvider }, testInfo) => {
    const oldAccounts = new events.EventEmitter();
    const freshAccounts = new events.EventEmitter();
    const requests = new events.EventEmitter();
    integrationProvider.accountsReady = events.once(oldAccounts, "ready");
    integrationProvider.onAccountsRequest = () => requests.emit("request");
    const firstRequest = events.once(requests, "request");
    await harness.loadThread({
      title: "Connect while accounts load",
      messages: [
        m.user("Connect my inbox"),
        m.connectionRequest({
          kind: "control-plane",
          integration: "google_gmail",
        }),
      ],
    });
    await firstRequest;
    const card = app.page.getByRole("region", {
      name: "Gmail connection",
      exact: true,
    });
    await expect(card).toContainText("Loading accounts…");
    await card.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(
      card.getByRole("button", { name: "Opened in your browser", exact: true }),
    ).toBeVisible();
    integrationProvider.accountsReady = events.once(freshAccounts, "ready");
    integrationProvider.accounts = true;
    const refreshRequest = events.once(requests, "request");
    integrationProvider.status = "ready";
    const updatingAccounts = card.getByText("Updating accounts…", {
      exact: true,
    });
    await expect(updatingAccounts).toBeVisible();
    oldAccounts.emit("ready");
    await refreshRequest;
    // The old empty response must not finish refresh or defer it to the next poll.
    await expect(card.getByRole("list", { name: "Accounts" })).toHaveCount(0);
    await expect(updatingAccounts).toBeVisible();
    await app.page.screenshot({
      path: testInfo.outputPath("connection-old-request-pending.png"),
    });
    freshAccounts.emit("ready");
    integrationProvider.accountsReady = undefined;
    await expect(card.getByRole("list", { name: "Accounts" })).toContainText(
      "alex@acme.com",
    );
    await expect(
      card.getByRole("button", { name: "Add account", exact: true }),
    ).toBeVisible();
  },
);

connectionTest(
  "shares an existing Add account attempt between generic and repaired cards",
  async ({ app, harness, integrationProvider }) => {
    integrationProvider.accounts = true;
    await harness.loadThread({
      title: "Shared Gmail setup",
      messages: [
        m.user("Connect another inbox and repair work Gmail"),
        m.connectionRequest({
          kind: "control-plane",
          integration: "google_gmail",
        }),
        m.connectionRequest({
          kind: "control-plane",
          integration: "google_gmail",
          connectionName: "work",
        }),
      ],
    });
    const cards = app.page.getByRole("region", {
      name: "Gmail connection",
      exact: true,
    });
    const generic = cards.first();
    const repaired = cards.last();
    await repaired
      .getByRole("button", { name: "Reconnect alex@acme.com", exact: true })
      .click();
    integrationProvider.status = "ready";
    const addAccount = repaired.getByRole("button", {
      name: "Add account",
      exact: true,
    });
    await expect(addAccount).toBeVisible();
    const externalUrls = await app.observeExternalUrls();
    await app.setExternalUrlFailure(true);
    await generic
      .getByRole("button", { name: "Add account", exact: true })
      .click();
    await expect(
      generic.getByRole("link", { name: "Open this link" }),
    ).toBeVisible();
    await addAccount.click();
    const setupLink = repaired.getByRole("link", { name: "Open this link" });
    await expect(setupLink).toBeVisible();
    await expect(
      repaired.getByRole("button", { name: "Cancel", exact: true }),
    ).toBeVisible();
    await expect(
      repaired.getByRole("button", {
        name: "Opened in your browser",
        exact: true,
      }),
    ).toHaveCount(0);
    await app.setExternalUrlFailure(false);
    await setupLink.click();
    await expect(
      repaired.getByRole("button", {
        name: "Opened in your browser",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      generic.getByRole("button", {
        name: "Opened in your browser",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(async () => await externalUrls.jsonValue())
      .toEqual([
        `${integrationProvider.origin}/integrations/setup/test-setup-2`,
        `${integrationProvider.origin}/integrations/setup/test-setup-2`,
      ]);
    await repaired.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(
      cards.getByRole("button", { name: "Cancel", exact: true }),
    ).toHaveCount(0);
    await expect(
      generic.getByRole("button", { name: "Add account", exact: true }),
    ).toBeVisible();
  },
);

e2eTest(
  "keeps multiple queued messages visible and delivers each in order",
  async ({ app, harness, llm }, testInfo) => {
    await harness.loadThread({
      title: "Queued messages",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Queued messages" });
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Start working");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.waitForRequest();
    for (const text of ["First queued message", "Second queued message"]) {
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await editor.fill(text);
      await pane.getByRole("button", { name: "Send", exact: true }).click();
      await expect(editor).toHaveAttribute("contenteditable", "true");
      await expect(editor).toBeEmpty();
    }
    const userMessages = pane.getByRole("article", { name: "You message" });
    for (const text of ["First queued message", "Second queued message"])
      await expect(userMessages.filter({ hasText: text })).toHaveCount(1);
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await app.page.screenshot({
      path: testInfo.outputPath("queue-desktop-1280x800.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page.screenshot({
      path: testInfo.outputPath("queue-mobile-390x844.png"),
    });
    await app.page.setViewportSize({ width: 1280, height: 800 });

    await llm.respond(m.assistant("Initial work finished."));
    await llm.respond(({ messages }) => {
      expect(
        messages.filter((message) => message.role === "user").map(messageText),
      ).toEqual(["Hello", "Start working", "First queued message"]);
      return m.assistant("First follow-up received.");
    });
    await llm.respond(({ messages }) => {
      expect(
        messages.filter((message) => message.role === "user").map(messageText),
      ).toEqual([
        "Hello",
        "Start working",
        "First queued message",
        "Second queued message",
      ]);
      return m.assistant("Both follow-ups received.");
    });
    await expect(pane.getByRole("log")).toContainText(
      "Both follow-ups received.",
    );
    await app.page.reload();
    for (const text of ["First queued message", "Second queued message"])
      await expect(userMessages.filter({ hasText: text })).toHaveCount(1);
  },
);

for (const toolName of ["bash", "exec"] as const)
  e2eTest(
    `stops a detached command through ${toolName} and can send another message`,
    async ({ app, harness, llm }, testInfo) => {
      await harness.loadThread({
        title: "Stop command",
        messages: [m.user("Hello"), m.assistant("Ready.")],
      });
      const pane = app.page.getByRole("main", { name: "Stop command" });
      await pane.getByLabel("Message", { exact: true }).fill("Run a command");
      await pane.getByRole("button", { name: "Send", exact: true }).click();
      // Node's detached spawn uses setsid on POSIX, including macOS where the
      // setsid command is not installed. The child retains the output pipes.
      const script = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify("process.on('SIGTERM', () => {}); require('node:fs').writeFileSync('detached.pid', String(process.pid)); setInterval(() => {}, 1000)")}], { detached: true, stdio: ['ignore', 1, 2] }).unref()`;
      const bashInput = {
        command: `node -e '${script.replaceAll("'", "'\\''")}'`,
        timeoutMs: 60_000,
      };
      await llm.respond(
        m.tool.start(toolName, {
          id: "detached-command",
          arguments:
            toolName === "bash"
              ? bashInput
              : { js: `await tools.bash.run(${JSON.stringify(bashInput)})` },
        }),
      );
      await expect
        .poll(async () => {
          const result = await harness.tools.bash.run({
            command: "test -f detached.pid",
          });
          return result.code;
        })
        .toBe(0);
      await pane
        .getByLabel("Message", { exact: true })
        .fill("Withdraw this queued message");
      await pane.getByRole("button", { name: "Send", exact: true }).click();
      await expect(
        pane
          .getByRole("article", { name: "You message" })
          .filter({ hasText: "Withdraw this queued message" }),
      ).toBeVisible();
      await pane.getByRole("button", { name: "Stop", exact: true }).click();
      await expect(
        pane
          .getByRole("status", { name: "", exact: true })
          .filter({ hasText: "Interrupted by user" }),
      ).toBeVisible();
      await expect(pane.getByRole("alert")).not.toBeVisible();
      await expect(
        pane.getByText("Withdraw this queued message", { exact: true }),
      ).not.toBeVisible();
      await expect
        .poll(async () => {
          const state = await harness.tools.bash.run({
            command: 'ps -p "$(cat detached.pid)" -o stat=',
          });
          return state.stdout.trim();
        })
        .toMatch(/^(?:Z.*)?$/u);
      await app.page.setViewportSize({ width: 1280, height: 800 });
      await app.page.screenshot({
        path: testInfo.outputPath("stopped-desktop-1280x800.png"),
      });
      await app.page.setViewportSize({ width: 390, height: 844 });
      await app.page.screenshot({
        path: testInfo.outputPath("stopped-mobile-390x844.png"),
      });
      await app.page.setViewportSize({ width: 1280, height: 800 });
      await pane
        .getByLabel("Message", { exact: true })
        .fill("Continue after stopping");
      await pane.getByRole("button", { name: "Send", exact: true }).click();
      await llm.respond(({ messages }) => {
        expect(messages.map(messageText).join("\n")).not.toContain(
          "Withdraw this queued message",
        );
        expect(messages.map(messageText).join("\n")).not.toContain(
          "Interrupted by user",
        );
        return m.assistant("Ready to continue.");
      });
      await expect(pane.getByRole("log")).toContainText("Ready to continue.");
      await expect(
        pane.getByText("Interrupted by user", { exact: true }),
      ).toHaveCount(1);
      await app.page.reload();
      await expect(
        pane.getByText("Interrupted by user", { exact: true }),
      ).toHaveCount(1);
      await expect(pane.getByRole("alert")).not.toBeVisible();
      await app.page.screenshot({
        path: testInfo.outputPath("interruption-retained-desktop-1280x800.png"),
      });
      await app.page.setViewportSize({ width: 390, height: 844 });
      await app.page.screenshot({
        path: testInfo.outputPath("interruption-retained-mobile-390x844.png"),
      });
    },
  );

e2eTest(
  "moves one queued message and its attachments and references into the existing draft",
  async ({ app, harness, llm }, testInfo) => {
    await harness.loadThread({
      title: "Edit queued message",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    await app.server.rpc.workspace.writeFile({
      path: "brief.md",
      content: "Release on Friday.",
    });
    const pane = app.page.getByRole("main", { name: "Edit queued message" });
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Start working");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.waitForRequest();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.fill("Remove this message @brief");
    await pane.getByRole("option", { name: /brief.md/ }).click();
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "queued.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("scarlet robin"),
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.fill("Keep this message queued");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.fill("Keep my draft");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("blue bicycle"),
    });
    const remove = pane.getByRole("button", {
      name: "Move queued message to draft",
      exact: true,
    });
    await expect(remove).toHaveCount(2);
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await app.page.screenshot({
      path: testInfo.outputPath("queue-actions-desktop-1280x800.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page.screenshot({
      path: testInfo.outputPath("queue-actions-mobile-390x844.png"),
    });
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await remove.first().click();
    await expect(remove).toHaveCount(1);
    await expect(editor).toContainText("Keep my draft");
    await expect(editor).toContainText("Remove this message");
    await expect(editor).toBeFocused();
    await expect(
      pane
        .getByRole("list", { name: "Attachments", exact: true })
        .getByRole("listitem"),
    ).toHaveCount(2);
    await expect(
      pane.getByRole("list", { name: "References", exact: true }),
    ).toContainText("brief.md");
    const transcript = pane.getByRole("log");
    await expect(transcript).not.toContainText("Remove this message");
    await expect(transcript).toContainText("Keep this message queued");
    await app.page.screenshot({
      path: testInfo.outputPath("restored-draft-desktop-1280x800.png"),
    });
    await app.page.setViewportSize({ width: 390, height: 844 });
    await app.page.screenshot({
      path: testInfo.outputPath("restored-draft-mobile-390x844.png"),
    });
    await app.page.setViewportSize({ width: 1280, height: 800 });
    await llm.respond(m.assistant("Initial work finished."));
    await llm.respond(({ messages }) => {
      expect(
        messages.filter((message) => message.role === "user").map(messageText),
      ).toEqual(["Hello", "Start working", "Keep this message queued"]);
      return m.assistant("Only the remaining queued message ran.");
    });
    await expect(transcript).toContainText(
      "Only the remaining queued message ran.",
    );
    await expect(editor).toContainText("Keep my draft");
    await expect(
      pane.getByText("Interrupted by user", { exact: true }),
    ).not.toBeVisible();
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      const text = messageText(
        messages.findLast((message) => message.role === "user")!,
      );
      for (const part of [
        "Keep my draft",
        "Remove this message",
        "scarlet robin",
        "blue bicycle",
        "brief.md",
      ])
        expect(text).toContain(part);
      return m.assistant("Edited message received with both files.");
    });
    await expect(transcript).toContainText(
      "Edited message received with both files.",
    );
  },
);

e2eTest(
  "scrolls a long input draft while keeping Send available",
  async ({ app, harness }, testInfo) => {
    await harness.loadThread({
      title: "Long input draft",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Long input draft" });
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.focus();
    await editor.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/html",
        [
          "<p>Start of long draft</p>",
          ...Array.from(
            { length: 150 },
            (_, index) =>
              `<p>Paragraph ${index}: This draft needs its own scrolling area.</p>`,
          ),
          "<p>End of long draft</p>",
        ].join(""),
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    for (const viewport of [
      { width: 1280, height: 800 },
      { width: 390, height: 844 },
    ]) {
      await app.page.setViewportSize(viewport);
      await editor.hover();
      await app.page.mouse.wheel(0, -100_000);
      await expect(
        editor.getByText("Start of long draft", { exact: true }),
      ).toBeInViewport();
      await expect(
        editor.getByText("End of long draft", { exact: true }),
      ).not.toBeInViewport();
      await expect(
        pane.getByRole("button", { name: "Send", exact: true }),
      ).toBeInViewport();
      await app.page.mouse.wheel(0, 100_000);
      await expect(
        editor.getByText("End of long draft", { exact: true }),
      ).toBeInViewport();
      await expect(
        editor.getByText("Start of long draft", { exact: true }),
      ).not.toBeInViewport();
      await expect(
        pane.getByRole("button", { name: "Send", exact: true }),
      ).toBeInViewport();
      await app.page.screenshot({
        path: testInfo.outputPath(
          `long-input-${viewport.width}x${viewport.height}.png`,
        ),
      });
    }
  },
);

e2eTest(
  "renders user Markdown links and formatting after sending and reloading",
  async ({ app, llm }, testInfo) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.focus();
    await editor.evaluate((element) => {
      const clipboardData = new DataTransfer();
      clipboardData.setData(
        "text/html",
        '<p>Can you connect <a href="https://mobbin.com/mcp">https://mobbin.com/mcp</a>?</p>' +
          '<p>Read <a href="https://mobbin.com/browse/ios/apps">Mobbin apps</a> and keep <code>[literal](https://example.com)</code> as code.</p>' +
          "<ul><li><strong>iOS</strong> screens</li><li>Web flows</li></ul>",
      );
      element.dispatchEvent(
        new ClipboardEvent("paste", {
          clipboardData,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await expect(
      editor.getByRole("link", { name: "Mobbin apps" }),
    ).toHaveAttribute("href", "https://mobbin.com/browse/ios/apps");
    await editor.getByText("Web flows", { exact: true }).click();
    await editor.press("End");
    await editor.press("Shift+Enter");
    await editor.pressSequentially("Desktop apps");
    await editor.press("Shift+Enter");
    await editor.press("Shift+Enter");
    await editor.pressSequentially("```");
    await editor.press("Shift+Enter");
    await editor.pressSequentially("npm run build");
    for (let count = 0; count < 3; count += 1)
      await editor.press("Shift+Enter");
    await editor.pressSequentially("After the code");
    await editor.press("Enter");
    const sent = pane.getByRole("article", { name: "You message" });
    const urlLink = sent.getByRole("link", {
      name: "https://mobbin.com/mcp",
      exact: true,
    });
    await expect(urlLink).toHaveCount(1);
    await expect(urlLink).toHaveAttribute("href", "https://mobbin.com/mcp");
    await expect(
      sent.getByRole("link", { name: "Mobbin apps" }),
    ).toHaveAttribute("href", "https://mobbin.com/browse/ios/apps");
    await expect(sent.locator("p code")).toHaveText(
      "[literal](https://example.com)",
    );
    await expect(sent.getByRole("link")).toHaveCount(2);
    await expect(editor).toBeEmpty();
    await expect(sent.getByRole("listitem")).toHaveText([
      "iOS screens",
      "Web flows",
      "Desktop apps",
    ]);
    await expect(sent.locator("pre")).toHaveText("npm run build");
    await expect(sent.locator("p").last()).toHaveText("After the code");
    await expect(sent.locator("strong")).toHaveText("iOS");
    await expect(sent).not.toContainText("[https://mobbin.com/mcp]");
    await llm.respond(
      m.assistant("See [Mobbin docs](https://mobbin.com/mcp)."),
    );
    await expect(
      pane.getByRole("link", { name: "Mobbin docs" }),
    ).toHaveAttribute("href", "https://mobbin.com/mcp");
    const externalUrls = await app.observeExternalUrls();
    await urlLink.click();
    await expect
      .poll(async () => await externalUrls.jsonValue())
      .toEqual(["https://mobbin.com/mcp"]);
    await app.page.reload();
    await expect(urlLink).toBeVisible();
    await expect(
      sent.getByRole("link", { name: "Mobbin apps" }),
    ).toHaveAttribute("href", "https://mobbin.com/browse/ios/apps");
    await expect(sent.locator("p code")).toHaveText(
      "[literal](https://example.com)",
    );
    await sent.screenshot({ path: testInfo.outputPath("user-markdown.png") });
  },
);

e2eTest(
  "references files and threads from a message",
  async ({ app, harness, llm }) => {
    await harness.loadThread({
      title: "Previous plan",
      messages: [
        m.user("What is the launch color?"),
        m.assistant("The launch color is indigo."),
      ],
    });
    await app.server.rpc.workspace.writeFile({
      path: "brief.md",
      content: "The release date is Friday.",
    });
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main", { name: "New thread" });
    const editor = pane.getByLabel("Message", { exact: true });
    await expect(editor).toBeFocused();
    await editor.fill("Compare @brief");
    await pane.getByRole("option", { name: /brief.md/ }).click();
    await expect(pane.getByRole("list", { name: "References" })).toContainText(
      "brief.md",
    );
    await editor.pressSequentially(" with @Previous");
    await pane.getByRole("option", { name: /Previous plan/ }).click();
    await expect(pane.getByRole("list", { name: "References" })).toContainText(
      "Previous plan",
    );
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(user).toBeDefined();
      expect(messageText(user!)).toContain('File: "brief.md"');
      expect(messageText(user!)).toContain("The launch color is indigo.");
      return m.assistant("I can compare those references.");
    });
    const sent = app.page.getByRole("article", { name: "You message" });
    await expect(sent.getByRole("list", { name: "References" })).toContainText(
      "brief.md",
    );
    await expect(sent.getByRole("list", { name: "References" })).toContainText(
      "Previous plan",
    );
    await sent.getByRole("link", { name: "Previous plan" }).click();
    await expect(
      app.page.getByRole("main", { name: "Previous plan" }),
    ).toBeVisible();
  },
);

e2eTest(
  "sends a message before its file finishes uploading and keeps later messages in order",
  async ({ app, harness, llm }) => {
    await harness.loadThread({
      title: "Send early",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Send early" });
    const editor = pane.getByLabel("Message", { exact: true });
    // Hold chunk uploads so the file is still uploading when the user sends.
    const held: Route[] = [];
    let holding = true;
    await app.page.route("**/rpc/uploads/write", async (route) => {
      if (holding) held.push(route);
      else await route.continue();
    });
    await editor.fill("What is in this archive?");
    await pane.getByLabel("Attach files", { exact: true }).setInputFiles({
      name: "archive.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(9 * 1024 * 1024, 7),
    });
    await expect.poll(() => held.length).toBe(1);
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const waiting = pane
      .getByRole("article", { name: "You message" })
      .filter({ hasText: "What is in this archive?" });
    await expect(waiting).toContainText(
      "Sends when its files finish uploading",
    );
    await expect(waiting.getByRole("listitem")).toContainText("0%");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await expect(editor).toHaveText("");
    // A later message without files waits behind the first one.
    await editor.fill("And summarize it");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      pane
        .getByRole("article", { name: "You message" })
        .filter({ hasText: "And summarize it" }),
    ).toBeVisible();
    holding = false;
    for (const route of held) await route.continue();
    await llm.respond(({ messages }) => {
      const users = messages
        .filter((message) => message.role === "user")
        .map(messageText);
      expect(users.at(-1)).toContain("What is in this archive?");
      expect(users.at(-1)).toContain("archive.bin");
      expect(users.join("\n")).not.toContain("And summarize it");
      return m.assistant("It is a binary archive.");
    });
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toBe("And summarize it");
      return m.assistant("Summary done.");
    });
    await expect(pane.getByRole("log")).toContainText("Summary done.");
    await expect(pane.getByRole("log")).not.toContainText(
      "Sends when its files finish uploading",
    );
  },
);

// Chromium's nested PDF frame can stall Playwright DOM snapshot evaluation on
// macOS before an assertion starts. Keep screenshots and action logs without
// injecting snapshot scripts into the native PDF viewer for this test.
const attachmentTest = e2eTest.extend({ traceSnapshots: false });

attachmentTest(
  "drops images, PDFs, and Word files into chat and keeps their model context after reload",
  async ({ app, llm }, testInfo) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    const pane = app.page.getByRole("main");
    const fixtures = await Promise.all(
      ["picture.png", "document.pdf", "document.docx"].map(async (name) => ({
        name,
        data: (
          await fs.readFile(
            path.resolve(
              import.meta.dirname,
              "../../../packages/workspace-server/test/fixtures/attachments",
              name,
            ),
          )
        ).toString("base64"),
      })),
    );
    const transfer = await app.page.evaluateHandle((files) => {
      const data = new DataTransfer();
      for (const file of files)
        data.items.add(
          new File(
            [Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0))],
            file.name,
          ),
        );
      return data;
    }, fixtures);
    const editor = pane.getByLabel("Message", { exact: true });
    await editor.fill("Summarize my attached files");
    await pane.dispatchEvent("dragenter", { dataTransfer: transfer });
    await expect(
      pane.getByText("Drop files to attach", { exact: true }),
    ).toBeVisible();
    await editor.dispatchEvent("dragover", { dataTransfer: transfer });
    await expect(
      pane.getByText("Drop files to attach", { exact: true }),
    ).toBeVisible();
    await app.page.screenshot({ path: testInfo.outputPath("file-drag.png") });
    await editor.dispatchEvent("drop", { dataTransfer: transfer });
    await transfer.dispose();
    await expect(
      pane.getByText("Drop files to attach", { exact: true }),
    ).not.toBeVisible();
    const attachments = pane.getByRole("list", {
      name: "Attachments",
      exact: true,
    });
    for (const fixture of fixtures)
      await expect(
        attachments.getByText(fixture.name, { exact: true }),
      ).toBeVisible();
    await app.page.screenshot({
      path: testInfo.outputPath("attachments-ready.png"),
    });
    const uploads: Route[] = [];
    await app.page.route("**/rpc/thread/prompt", (route) => {
      uploads.push(route);
    });
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(() => uploads.length).toBe(1);
    await expect(
      pane.getByRole("button", { name: "Send", exact: true }),
    ).toBeDisabled();
    await expect(pane.getByRole("status")).toHaveText("Preparing attachments…");
    await expect(attachments.getByRole("listitem")).toHaveCount(3);
    await uploads[0]!.continue();
    await app.page.unroute("**/rpc/thread/prompt");
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user");
      expect(user).toBeDefined();
      expect(messageText(user!)).toContain("scarlet robin");
      expect(messageText(user!)).toContain("orange heron");
      expect(
        Array.isArray(user!.content)
          ? user!.content.filter((part) => part.type === "image_url")
          : [],
      ).toHaveLength(4);
      return m.assistant(
        "The Word document says scarlet robin; the PDF says orange heron. I can see the image and both PDF pages.",
      );
    });
    const userMessage = pane.getByRole("article", { name: "You message" });
    await expect(userMessage).toContainText("Summarize my attached files");
    await expect(
      userMessage
        .getByRole("list", { name: "Attached files" })
        .getByRole("listitem"),
    ).toHaveCount(3);
    await expect(userMessage).not.toContainText("scarlet robin");
    await expect(pane.getByRole("log")).toContainText(
      "I can see the image and both PDF pages.",
    );
    const chatTabTitle = await app.page
      .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
      .getByRole("button", { pressed: true })
      .innerText();
    const chatTab = app.page
      .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
      .getByRole("button", { name: chatTabTitle, exact: true });
    const initialTabCount = await app.page
      .locator("[role=toolbar] button[aria-pressed]")
      .count();
    await editor.fill("Keep this follow-up draft");
    for (const [index, name] of [
      "picture.png",
      "document.pdf",
      "document.docx",
    ].entries()) {
      await userMessage.getByRole("link", { name, exact: true }).click();
      await expect(
        app.page.locator("[role=toolbar] button[aria-pressed]"),
      ).toHaveCount(initialTabCount + index + 1);
      await expect(
        app.page
          .getByRole("toolbar", { name: /^Pane \d+ tabs$/ })
          .getByRole("button", { pressed: true }),
      ).toHaveText(name);
      await expect(chatTab).toBeVisible();
      await chatTab.click();
      await expect(editor).toHaveText("Keep this follow-up draft");
      await expect(userMessage).toContainText("Summarize my attached files");
    }
    await userMessage
      .getByRole("link", { name: "picture.png", exact: true })
      .click();
    await expect(
      app.page.locator("[role=toolbar] button[aria-pressed]"),
    ).toHaveCount(initialTabCount + 3);
    await expect(
      app.page.getByRole("img", { name: /\/picture\.png$/ }),
    ).toBeVisible();
    await chatTab.click();
    await app.page.reload();
    await expect(
      userMessage.getByRole("link", { name: "document.docx", exact: true }),
    ).toBeVisible();
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Recall those attachments");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) => {
      const context = messages.map(messageText).join("\n");
      expect(context).toContain("scarlet robin");
      expect(context).toContain("coral raven");
      return m.assistant("I still have the attached file contents.");
    });
    await expect(pane.getByRole("log")).toContainText(
      "I still have the attached file contents.",
    );
  },
);

e2eTest(
  "keeps rendering a long thread while a response streams faster than it renders",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(120_000);
    const pageErrors: string[] = [];
    app.page.on("pageerror", (error) =>
      pageErrors.push(error.stack ?? error.message),
    );
    await harness.loadThread({
      title: "Long conversation",
      messages: Array.from({ length: 400 }, (_, index) => [
        m.user(`Question ${index}: Please explain step ${index} in detail.`),
        m.assistant(
          [
            `## Answer ${index}`,
            "",
            `Step ${index} has a detailed explanation with \`code\` and a list:`,
            "",
            "- first point",
            "- second point",
            "",
            "| Column | Value |",
            "| --- | --- |",
            `| step | ${index} |`,
            "",
            "```ts",
            `const step = ${index};`,
            "```",
          ].join("\n"),
        ),
      ]).flat(),
    });
    const thread = app.page.getByRole("main", { name: "Long conversation" });
    const transcript = thread.getByRole("log", { name: "Thread transcript" });
    await expect(transcript).toContainText("Answer 399");

    // Keep renderer work slower than incoming deltas on fast CI machines.
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 4 });

    await thread.getByLabel("Message", { exact: true }).fill("Keep going");
    await thread.getByRole("button", { name: "Send", exact: true }).click();
    const response = await llm.stream();
    // Each delta re-renders the whole transcript. Deltas that arrive faster
    // than that render once made React count the Find updates as nested and
    // unmount the window with "Maximum update depth exceeded".
    for (let index = 0; index < 2_000; index++) {
      response.write(m.assistant(`token-${index} `));
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    response.end();
    await expect
      .poll(
        async () =>
          pageErrors[0] ??
          (await transcript.textContent())?.includes("token-1999"),
        { timeout: 60_000 },
      )
      .toBe(true);
    expect(pageErrors).toEqual([]);
    await expect(transcript).toContainText("Answer 399");
  },
);

e2eTest("starts a new thread", async ({ harness, app }) => {
  await harness.loadThread({
    title: "Existing conversation",
    messages: [
      m.user("Summarize this workspace"),
      m.assistant("Here is the summary."),
    ],
  });

  await app.page.getByRole("button", { name: "New tab", exact: true }).click();

  const newThread = app.page.getByRole("main", {
    name: "New thread",
    exact: true,
  });
  await expect(newThread).toBeVisible();
  await expect(newThread.getByLabel("Message", { exact: true })).toBeFocused();
});

e2eTest(
  "keeps ordinary conversations usable while workspace metadata sync is delayed",
  async ({ harness, app, llm }) => {
    await harness.loadThread({
      title: "Independent conversation",
      messages: [m.user("Hello"), m.assistant("Ready to continue.")],
    });
    const pendingPulls: (() => void)[] = [];
    await routeWorkspaceRpc(app.page, (request) => {
      if (request.path === "/sync/pull") pendingPulls.push(request.continue);
      else request.continue();
    });
    await app.page.reload();
    await expect.poll(() => pendingPulls.length).toBeGreaterThan(0);

    const pane = app.page.getByRole("main", {
      name: "Independent conversation",
    });
    await expect(pane.getByRole("log")).toContainText("Ready to continue.");
    await pane.getByLabel("Message", { exact: true }).fill("Keep working");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    const response = await llm.stream();
    response.write(m.assistant("Work in progress."));
    await expect(pane.getByRole("log")).toContainText("Work in progress.");
    await pane.getByRole("button", { name: "Stop", exact: true }).click();
    response.end();
    await expect(
      pane.getByText("Interrupted by user", { exact: true }),
    ).toBeVisible();
    await expect(pane.getByLabel("Message", { exact: true })).toHaveAttribute(
      "contenteditable",
      "true",
    );

    for (const resume of pendingPulls) resume();
    await expect(pane.getByRole("log")).toContainText("Ready to continue.");
  },
);

e2eTest(
  "continues with saved messages and tool results after quitting Halo",
  async ({ app, harness, llm }) => {
    await harness.tools.files.write({
      path: "notes.md",
      content: "The project mascot is a blue bicycle.",
    });
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Read the project notes");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond([
      m.assistant("I will read the notes."),
      m.tool.start("read", {
        id: "read-notes",
        arguments: { path: "notes.md" },
      }),
    ]);
    await llm.respond(m.assistant("The notes are saved."));
    await expect(app.page.getByRole("main")).toContainText(
      "The notes are saved.",
    );
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();

    await app.quit();
    await app.open();

    const pane = app.page.getByRole("main");
    const transcript = pane.getByRole("log", { name: "Thread transcript" });
    await expect(
      transcript.getByText("Read the project notes", { exact: true }),
    ).toBeVisible();
    await expect(
      transcript.getByText("The notes are saved.", {
        exact: true,
      }),
    ).toBeVisible();

    await pane
      .getByLabel("Message", { exact: true })
      .fill("Continue the conversation");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(({ messages }) =>
      m.assistant(
        [
          `Earlier prompts: ${messages
            .filter((message) => message.role === "user")
            .map((message) => messageText(message))
            .join(" → ")}`,
          `Earlier answers: ${messages
            .filter((message) => message.role === "assistant")
            .map((message) => messageText(message))
            .join(" → ")}`,
          `Earlier tool results: ${messages
            .filter((message) => message.role === "tool")
            .map((message) => messageText(message))
            .join("\n")}`,
        ].join("\n\n"),
      ),
    );
    await expect(
      transcript.getByText(
        "Earlier prompts: Read the project notes → Continue the conversation",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      transcript.getByText(
        "Earlier answers: I will read the notes. → The notes are saved.",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      transcript.getByText(
        "Earlier tool results: The project mascot is a blue bicycle.",
        { exact: true },
      ),
    ).toBeVisible();
  },
);

e2eTest(
  "finishes a pending response while Electron is closed",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Start an answer");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(
      app.page.getByRole("article", { name: "You message" }),
    ).toContainText("Start an answer");

    await llm.waitForRequest();
    await app.quit();
    await llm.respond(
      m.assistant("The server finished while Electron was closed."),
    );
    await app.open();

    await expect(app.page.getByRole("main")).toContainText(
      "The server finished while Electron was closed.",
    );
  },
);

e2eTest(
  "restores partial assistant text on reload and continues the same response",
  async ({ app, llm }) => {
    await app.page
      .getByRole("button", { name: "New tab", exact: true })
      .click();
    await app.page
      .getByRole("main")
      .getByLabel("Message", { exact: true })
      .fill("Explain the plan");
    await app.page.getByRole("button", { name: "Send", exact: true }).click();
    const response = await llm.stream();
    response.write(m.assistant("The first step"));
    await expect(
      app.page.getByRole("log", { name: "Thread transcript" }),
    ).toContainText("The first step");

    await app.page.reload();

    const transcript = app.page.getByRole("log", {
      name: "Thread transcript",
    });
    await expect(transcript).toContainText("The first step");
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).toBeVisible();
    response.write(m.assistant(" is to save the notes."));
    response.end();
    await expect(
      transcript.getByText("The first step is to save the notes.", {
        exact: true,
      }),
    ).toHaveCount(1);
    await expect(
      app.page.getByRole("button", { name: "Stop", exact: true }),
    ).not.toBeVisible();
  },
);
