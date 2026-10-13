import { beforeEach, expect, test, vi } from "vitest";

const signOut = vi.fn();

vi.stubGlobal("window", {
  location: {
    origin: "https://staging.gethalo.dev",
    host: "staging.gethalo.dev",
    pathname: "/",
    href: "https://staging.gethalo.dev/",
  },
});

vi.mock("better-auth/client", () => ({
  createAuthClient: () => ({ signOut }),
}));

// The package entry also loads tandem-core, whose extensionless ESM imports
// Node cannot resolve outside its own vitest config; reuse the leaf modules.
vi.mock("@get-halo/client", async () => ({
  ...(await import("../../../packages/client/src/protocol.js")),
  ...(await import("../../../packages/client/src/connectionErrors.js")),
  connectHaloClient: vi.fn(),
}));

const { WebHost } = await import("../src/WebHost.js");

beforeEach(() => {
  signOut.mockReset();
});

test("app info names the deployment this page signs in to", async () => {
  const info = await new WebHost().getAppInfo();
  expect(info.deployment).toBe("staging.gethalo.dev");
});

test("sign out succeeds when Better Auth reports no error", async () => {
  // oxlint-disable-next-line unicorn/no-null -- Better Auth reports success with null.
  signOut.mockResolvedValue({ data: { success: true }, error: null });
  expect(await new WebHost().signOut()).toBeUndefined();
  expect(signOut).toHaveBeenCalledOnce();
});

test("sign out returns an error when Better Auth reports one", async () => {
  signOut.mockResolvedValue({
    data: null,
    error: { status: 500, message: "server error" },
  });
  const result = await new WebHost().signOut();
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toBe(
    "Halo could not sign out through its web host.",
  );
  expect((result as Error).cause).toEqual({
    status: 500,
    message: "server error",
  });
});

test("sign out returns an error when the request rejects", async () => {
  const offline = new TypeError("Failed to fetch");
  signOut.mockRejectedValue(offline);
  const result = await new WebHost().signOut();
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).cause).toBe(offline);
});
