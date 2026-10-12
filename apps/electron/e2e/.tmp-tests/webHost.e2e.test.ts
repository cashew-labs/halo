import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect } from "@playwright/test";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { ControlPlane } from "../../../control-plane/src/server/ControlPlane.js";
import { LocalWorkspaceProvider } from "../../../control-plane/src/workspace/provider/local/LocalWorkspaceProvider.js";
import { WebHost } from "../../../web-app/src/WebHost.js";
import { e2eTest } from "../e2eTest.js";

e2eTest(
  "web host reuses its identity across real gateway reconnects and isolates tabs",
  async ({ server, testArtifacts }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    await server.rpc.server.info();
    const appDataDir = testArtifacts.paths.userData;
    const secret = "test-control-plane-auth-secret-key!";
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: { secret, googleClientId: "test", googleClientSecret: "test" },
      },
      webRoot: path.resolve(import.meta.dirname, "../../../web-app/dist"),
      workspaceProvider: new LocalWorkspaceProvider({ appDataDir }),
    });
    if (plane instanceof Error) throw plane;
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) throw closed;
    });
    using database = new DatabaseSync(
      path.join(appDataDir, "control-plane.db"),
    );
    const auth = betterAuth({
      baseURL: plane.origin,
      secret,
      database,
      plugins: [testUtils()],
    });
    const context = await auth.$context;
    const user = context.test.createUser({
      email: "owner@example.com",
      name: "Owner",
    });
    await context.test.saveUser(user);
    const login = await context.test.login({ userId: user.id });
    const cookie = login.headers.get("cookie");
    if (cookie === null) throw new Error("missing test cookie");
    const previousWindow = Object.getOwnPropertyDescriptor(
      globalThis,
      "window",
    );
    const realFetch = globalThis.fetch;
    // Supply browser URL/cookie semantics only. Every request reaches the real
    // control plane and workspace; no app service or transport response is mocked.
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: new URL(plane.origin) },
    });
    cleanup.defer(() => {
      globalThis.fetch = realFetch;
      if (previousWindow === undefined)
        Reflect.deleteProperty(globalThis, "window");
      else Object.defineProperty(globalThis, "window", previousWindow);
    });
    const ids: string[] = [];
    globalThis.fetch = async (input, init) => {
      const url = new URL(
        input instanceof Request ? input.url : input,
        plane.origin,
      );
      const headers = new Headers(
        input instanceof Request ? input.headers : init?.headers,
      );
      if (url.origin === plane.origin) headers.set("cookie", cookie);
      if (url.pathname === "/workspace/rpc/connect")
        ids.push(headers.get("x-halo-client-id") ?? "");
      return await realFetch(input instanceof Request ? input : url, {
        ...init,
        headers,
      });
    };
    const first = new WebHost();
    for (const host of [first, first, new WebHost()]) {
      const controller = new AbortController();
      cleanup.defer(() => controller.abort());
      const connected = await host.connectHalo({ signal: controller.signal });
      if (connected === undefined || connected instanceof Error)
        throw connected ?? new Error("not connected");
      expect(await connected.workspace.get()).toHaveProperty("workspaceRoot");
      controller.abort();
    }
    expect(ids).toHaveLength(3);
    expect(ids[0]).toMatch(/^[a-f0-9-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(ids[2]).not.toBe(ids[0]);
  },
);
