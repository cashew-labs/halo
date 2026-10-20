import { expect, test } from "vitest";
import { creatorHandle, isCreatorHost, normalizeHost } from "./creatorHost.js";

// Durable: default ports must preserve the main/creator host isolation boundary.
test.for([
  ["https://gethalo.dev", "GETHALO.DEV:443", "gethalo.dev"],
  ["http://halo.example", "HALO.EXAMPLE:80", "halo.example"],
  ["https://gethalo.dev", "www.gethalo.dev:443", "www.gethalo.dev"],
  ["https://gethalo.dev", "gethalo.dev:8443", "gethalo.dev:8443"],
  ["https://gethalo.dev", "gethalo.dev:80", "gethalo.dev:80"],
  ["http://halo.example", "halo.example:443", "halo.example:443"],
  ["https://gethalo.dev", "gethalo.dev.evil:443", "gethalo.dev.evil"],
  ["http://localhost:8787", "localhost:8787", "localhost:8787"],
])(
  "normalizes only the origin's default port: %s %s",
  ([publicOrigin, host, expected]) => {
    expect(normalizeHost({ publicOrigin: publicOrigin!, host })).toBe(expected);
  },
);
test("keeps creator and reserved hosts outside Halo with explicit HTTPS ports", () => {
  const publicOrigin = "https://gethalo.dev";
  expect(creatorHandle({ publicOrigin, host: "ALICE.GETHALO.DEV:443" })).toBe(
    "alice",
  );
  expect(isCreatorHost({ publicOrigin, host: "alice.gethalo.dev:443" })).toBe(
    true,
  );
  expect(
    creatorHandle({ publicOrigin, host: "go.gethalo.dev:443" }),
  ).toBeUndefined();
  expect(isCreatorHost({ publicOrigin, host: "go.gethalo.dev:443" })).toBe(
    true,
  );
  expect(isCreatorHost({ publicOrigin, host: "www.gethalo.dev:443" })).toBe(
    false,
  );
  expect(isCreatorHost({ publicOrigin, host: "evil.example:443" })).toBe(false);
  expect(normalizeHost({ publicOrigin, host: undefined })).toBe("");
});
