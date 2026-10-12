import { expect, type WebSocketRoute } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "recovers from silent and repeated socket loss without accumulating connections",
  async ({ app }, testInfo) => {
    const routes = new Map<WebSocketRoute, WebSocketRoute>();
    const abandoned = new Set<WebSocketRoute>();
    const httpRpc: string[] = [];
    let attempts = 0;
    app.page.on("request", (request) => {
      if (
        new URL(request.url()).pathname.startsWith("/rpc/") &&
        !request.url().endsWith("/rpc/connect") &&
        !request.url().endsWith("/rpc/server/info")
      )
        httpRpc.push(request.url());
    });
    await app.page.routeWebSocket("**/rpc/socket", (client) => {
      const server = client.connectToServer();
      attempts++;
      routes.set(client, server);
      client.onMessage((data) => {
        if (!abandoned.has(client)) server.send(data);
      });
      server.onMessage((data) => {
        if (!abandoned.has(client)) client.send(data);
      });
      client.onClose(async () => {
        if (!abandoned.has(client)) await server.close();
      });
      server.onClose(async () => {
        routes.delete(client);
        await client.close();
      });
    });
    await app.page.clock.install();
    await app.page.reload();
    const connected = app.page.getByRole("status", {
      name: "Connection: Connected",
      exact: true,
    });
    await expect(connected).toBeVisible();
    const input = app.page
      .locator('[data-testid="pane-tab-content"]:visible')
      .getByLabel("Message", { exact: true });
    await input.fill("Preserve this during a silently broken connection");
    expect(routes.size).toBe(1);
    for (const client of routes.keys()) abandoned.add(client);
    await app.server.rpc.workspace.writeFile({
      path: "during-outage.md",
      content: "Catch up after reconnect",
    });
    // Drop both directions and swallow the client's close: the VM cannot observe departure.
    await app.page.clock.fastForward(91_000);
    await expect.poll(() => attempts).toBeGreaterThan(1);
    await expect(connected).toBeVisible();
    await expect.poll(() => routes.size).toBe(1);
    await expect(
      app.page.getByRole("link", { name: "during-outage.md", exact: true }),
    ).toBeVisible();
    await expect(input).toHaveText(
      "Preserve this during a silently broken connection",
    );
    for (let index = 0; index < 5; index++) {
      const before = attempts;
      for (const [client, server] of routes) {
        await client.close({ code: 1012, reason: "simulated restart" });
        await server.close();
        routes.delete(client);
      }
      await expect.poll(() => attempts).toBeGreaterThan(before);
      await expect(connected).toBeVisible();
      await expect.poll(() => routes.size).toBe(1);
    }
    await expect(input).toHaveText(
      "Preserve this during a silently broken connection",
    );
    expect(await app.server.rpc.thread.list()).toHaveLength(0);
    expect(httpRpc).toEqual([]);
    await app.page.screenshot({
      path: testInfo.outputPath("recovered-workspace.png"),
    });
  },
);
