import { afterEach, expect, test, vi } from "vitest";

const handlers: ((event: unknown, request: unknown) => Promise<unknown>)[] =
  [];
const opened: string[] = [];
const started = {
  status: "authorization-required" as const,
  authorizationUrl: "https://halo.example/integrations/setup/setup-1",
  connectionId: "c1",
  expiresAt: 1,
  wasConnected: false,
};

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents: () => ({}) },
  ipcMain: {
    handle: (_channel: string, handler: (typeof handlers)[number]) =>
      handlers.push(handler),
  },
  safeStorage: {},
}));
vi.mock("../src/main/openExternalUrl.ts", () => ({
  openExternalUrl: async (url: string) => {
    opened.push(url);
  },
}));
vi.mock("@get-halo/client", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createHaloClient: () => ({
    thread: {
      startConnection: async () => started,
      cancelConnection: async () => undefined,
    },
  }),
}));

const { registerDesktopApi } = await import(
  "../src/main/api/registerDesktopApi.ts"
);
const { ControlPlaneAuth } = await import(
  "../src/main/auth/ControlPlaneAuth.ts"
);

afterEach(() => {
  handlers.length = 0;
  opened.length = 0;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function connect(
  createSetupHandoff?: (url: string) => Promise<string | Error>,
) {
  registerDesktopApi({
    authentication: {
      getWorkspaceConnection: async () => undefined,
      getSession: async () => undefined,
      signIn: async () => new Error("unused"),
      createSetupHandoff,
    },
    appUpdates: {} as never,
    getConnection: async () => ({
      url: "http://127.0.0.1:1",
      token: "t",
    }),
    ownsWindow: () => true,
  });
  return await handlers[0]!(
    { sender: {} },
    {
      type: "connectIntegration",
      sessionId: "s1",
      request: { kind: "control-plane", integration: "gmail" },
    },
  );
}

test("the desktop opens the handoff link for a setup", async () => {
  const createSetupHandoff = vi.fn(
    async (url: string) => `${url}#handoff=secret`,
  );
  expect(await connect(createSetupHandoff)).toEqual(started);
  expect(createSetupHandoff).toHaveBeenCalledWith(started.authorizationUrl);
  expect(opened).toEqual([`${started.authorizationUrl}#handoff=secret`]);
});

test("the desktop opens the plain setup link without a handoff", async () => {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  await connect(async () => new Error("offline"));
  expect(warn).toHaveBeenCalled();
  await connect(undefined);
  expect(opened).toEqual([
    started.authorizationUrl,
    started.authorizationUrl,
  ]);
});

function auth(token: string | undefined) {
  // SAFETY: The test builds the session directly instead of reading storage.
  return new (ControlPlaneAuth as unknown as new (ctx: object) => {
    createSetupHandoff(url: string): Promise<string | Error>;
  })({
    origin: "https://halo.example",
    restoreError: undefined,
    sessionStore: undefined,
    token,
  });
}

test("a signed-in desktop asks the control plane for a handoff", async () => {
  const requests: { url: string; body: string; authorization: string }[] =
    [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({
      url: request.url,
      body: await request.text(),
      authorization: request.headers.get("authorization") ?? "",
    });
    return Response.json({
      json: { url: "https://halo.example/integrations/setup/setup-1#handoff=x" },
    });
  });
  expect(
    await auth("token").createSetupHandoff(started.authorizationUrl),
  ).toBe("https://halo.example/integrations/setup/setup-1#handoff=x");
  expect(requests).toMatchObject([
    {
      url: "https://halo.example/rpc/integrations/createSetupHandoff",
      authorization: "Bearer token",
    },
  ]);
  expect(JSON.parse(requests[0]!.body)).toMatchObject({
    json: { setupId: "setup-1" },
  });
});

test("the desktop leaves other links and signed-out sessions unchanged", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  const other = "https://provider.example/integrations/setup/setup-1";
  expect(await auth("token").createSetupHandoff(other)).toBe(other);
  expect(
    await auth("token").createSetupHandoff("https://halo.example/settings"),
  ).toBe("https://halo.example/settings");
  expect(await auth(undefined).createSetupHandoff(started.authorizationUrl)).toBe(
    started.authorizationUrl,
  );
  expect(fetch).not.toHaveBeenCalled();
});

test("a failed handoff request returns an error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  expect(
    await auth("token").createSetupHandoff(started.authorizationUrl),
  ).toBeInstanceOf(Error);
});
