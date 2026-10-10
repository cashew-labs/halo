import { afterEach, expect, test, vi } from "vitest";

globalThis.window = {
  location: {
    origin: "https://halo.example",
    href: "https://halo.example/integrations/setup/s1",
    pathname: "/integrations/setup/s1",
  },
} as unknown as Window & typeof globalThis;

const { WebHost } = await import("../src/WebHost.ts");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

test("redeeming a handoff posts it to the control plane on this origin", async () => {
  const requests: { url: string; body: unknown }[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, body: await request.json() });
    return Response.json({});
  });
  expect(
    await new WebHost().integrationSetup.redeemHandoff({
      setupId: "s1",
      handoff: "secret",
    }),
  ).toBeUndefined();
  expect(requests).toEqual([
    {
      url: "https://halo.example/rpc/integrations/redeemSetupHandoff",
      body: { json: { setupId: "s1", handoff: "secret" } },
    },
  ]);
});

test("a rejected handoff becomes a web host error", async () => {
  vi.stubGlobal("fetch", async () => {
    throw new Error("offline");
  });
  const result = await new WebHost().integrationSetup.redeemHandoff({
    setupId: "s1",
    handoff: "secret",
  });
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain("open connection setup");
});

test("signing in from a setup uses the host's sign-in", async () => {
  const signIn = vi
    .spyOn(WebHost.prototype, "signIn")
    .mockResolvedValue(undefined);
  await new WebHost().integrationSetup.signIn();
  expect(signIn).toHaveBeenCalledTimes(1);
});
