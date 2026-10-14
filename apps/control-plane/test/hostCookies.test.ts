import fs from "node:fs/promises";
import path from "node:path";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { DatabaseSync } from "node:sqlite";
import { expect, test } from "vitest";
import { AuthService, authCookieOptions } from "../src/auth/AuthService.js";
import { DatabaseService } from "../src/DatabaseService.js";

const secret = "test-control-plane-auth-secret-key!";

test("HTTPS deployments use host-only __Host- cookies that sibling hosts cannot shadow", async () => {
  const parent = path.resolve(
    import.meta.dirname,
    "../../../tmp/control-plane",
  );
  await fs.mkdir(parent, { recursive: true });
  const directory = await fs.mkdtemp(path.join(parent, "cookies-"));
  const db = await DatabaseService.start({
    type: "sqlite",
    path: path.join(directory, "control-plane.db"),
  });
  if (db instanceof Error) throw db;
  try {
    const origin = "https://halo.test";
    const auth = await AuthService.start({
      db,
      origin,
      secret,
      googleClientId: "id.apps.googleusercontent.com",
      googleClientSecret: "secret",
    });
    if (auth instanceof Error) throw auth;
    // Real Better Auth responses: the OAuth state cookie of a sign-in.
    const started = await auth.startAppSignIn(
      `${origin}/api/apps/handoff?host=creator&return=/books/view/`,
    );
    if (started instanceof Error) throw started;
    const cookies = started.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    for (const cookie of cookies) {
      expect(cookie).toMatch(/^__Host-halo\./);
      expect(cookie).toMatch(/; Secure/i);
      expect(cookie).toMatch(/; Path=\/(;|$)/);
      expect(cookie).not.toMatch(/Domain=/i);
    }
    // A session cookie under that name authenticates; the same token planted
    // under a name a sibling subdomain could set does not.
    using database = new DatabaseSync(path.join(directory, "control-plane.db"));
    const helper = betterAuth({
      baseURL: origin,
      secret,
      database,
      advanced: authCookieOptions(origin),
      plugins: [testUtils()],
    });
    const context = await helper.$context;
    const user = context.test.createUser({
      email: "owner@example.com",
      name: "Owner",
    });
    await context.test.saveUser(user);
    const login = await context.test.login({ userId: user.id });
    const cookie = login.headers.get("cookie")!;
    expect(cookie).toMatch(/^__Host-halo\.session_token=/);
    const session = await auth.getSession(new Headers({ cookie }));
    expect(session).toMatchObject({ user: { email: "owner@example.com" } });
    const value = cookie.slice(cookie.indexOf("=") + 1);
    for (const name of [
      "better-auth.session_token",
      "__Secure-better-auth.session_token",
      "halo.session_token",
    ])
      expect(
        await auth.getSession(new Headers({ cookie: `${name}=${value}` })),
      ).toBeUndefined();
    // HTTP development keeps Better Auth's defaults.
    expect(authCookieOptions("http://127.0.0.1:4000")).toEqual({});
  } finally {
    await db.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});
