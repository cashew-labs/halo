import { expect, test } from "vitest";
import { setupBrowserCookie, setupBrowserCookies } from "../setupBrowserCookie.js";

test("on HTTPS only the __Host- setup cookie a sibling host cannot set authorizes a browser", () => {
  const origin = "https://halo.example";
  const issued = setupBrowserCookie({ setupId: "setup-1", browser: "secret", publicOrigin: origin });
  expect(issued).toMatch(/^__Host-halo_setup_setup-1=secret; Path=\/;/);
  expect(issued).toContain("Secure");
  expect(issued).not.toMatch(/Domain=/i);
  // A creator host can plant an unprefixed cookie with Domain=halo.example; it is ignored.
  const planted = new Headers({ cookie: "halo_setup_setup-1=attacker; __Host-halo_setup_setup-2=mine" });
  expect([...setupBrowserCookies(planted, origin)]).toEqual([["setup-2", "mine"]]);
});

test("HTTP development keeps unprefixed setup cookies", () => {
  const origin = "http://127.0.0.1:8787";
  expect(setupBrowserCookie({ setupId: "s", browser: "b", publicOrigin: origin })).toMatch(/^halo_setup_s=b; /);
  expect([...setupBrowserCookies(new Headers({ cookie: "halo_setup_s=b" }), origin)]).toEqual([["s", "b"]]);
});
