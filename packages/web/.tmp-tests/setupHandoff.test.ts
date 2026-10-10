import { expect, test } from "vitest";

const replaced: string[] = [];
globalThis.window = {
  location: { pathname: "/integrations/setup/s1", search: "", hash: "" },
  history: {
    state: undefined,
    replaceState: (_state: unknown, _title: string, url: string) =>
      replaced.push(url),
  },
} as unknown as Window & typeof globalThis;

const { SetupUnavailableError, setupReader } = await import(
  "../src/setupHandoff.ts"
);

function api(options: { redeemFails?: boolean; readFails?: boolean } = {}) {
  const calls: string[] = [];
  return {
    calls,
    redeemHandoff: async () => {
      calls.push("redeem");
      // Let a read that does not wait for redemption overtake it.
      await new Promise((resolve) => setTimeout(resolve, 5));
      calls.push("redeemed");
      return options.redeemFails ? new Error("used") : undefined;
    },
    read: async () => {
      calls.push("read");
      return options.readFails
        ? new Error("unauthorized")
        : ({ setupId: "s1" } as never);
    },
  };
}

test("the handoff is redeemed once, before every read, and removed from the URL", async () => {
  replaced.length = 0;
  const fake = api();
  const read = setupReader({ setupId: "s1", handoff: "secret", api: fake });
  expect(await Promise.all([read(), read()])).toEqual([
    { setupId: "s1" },
    { setupId: "s1" },
  ]);
  await read();
  expect(fake.calls).toEqual(["redeem", "redeemed", "read", "read", "read"]);
  expect(replaced).toEqual(["/integrations/setup/s1"]);
});

test("a page without a handoff reads the setup directly", async () => {
  replaced.length = 0;
  const fake = api();
  await setupReader({ setupId: "s1", handoff: undefined, api: fake })();
  expect(fake.calls).toEqual(["read"]);
  expect(replaced).toEqual([]);
});

test("an unavailable setup reports whether its handoff failed", async () => {
  const failed = await setupReader({
    setupId: "s1",
    handoff: "used",
    api: api({ redeemFails: true, readFails: true }),
  })();
  expect(failed).toBeInstanceOf(SetupUnavailableError);
  expect((failed as InstanceType<typeof SetupUnavailableError>).handoff).toBe(
    "failed",
  );
  const unsigned = await setupReader({
    setupId: "s1",
    handoff: undefined,
    api: api({ readFails: true }),
  })();
  expect((unsigned as InstanceType<typeof SetupUnavailableError>).handoff).toBe(
    "none",
  );
});
