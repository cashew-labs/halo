import { expect, test } from "vitest";
import {
  setupBrowserCookie,
  setupBrowserCookies,
} from "../src/integrations/setupBrowserCookie.ts";

test("the setup cookie is HttpOnly, Lax and Secure on HTTPS", () => {
  expect(
    setupBrowserCookie({
      setupId: "s1",
      browser: "secret",
      publicOrigin: "https://gethalo.dev",
    }),
  ).toBe("halo_setup_s1=secret; Path=/; Max-Age=900; HttpOnly; SameSite=Lax; Secure");
  expect(
    setupBrowserCookie({
      setupId: "s1",
      browser: "secret",
      publicOrigin: "http://127.0.0.1:3000",
    }),
  ).not.toContain("Secure");
});

test("setup cookies are read per setup and other cookies are ignored", () => {
  const browsers = setupBrowserCookies(
    new Headers({
      cookie:
        "better-auth.session_token=abc; halo_setup_s1=one; broken; halo_setup_s2 = two",
    }),
  );
  expect([...browsers]).toEqual([
    ["s1", "one"],
    ["s2", "two"],
  ]);
  expect(setupBrowserCookies(new Headers()).size).toBe(0);
});
