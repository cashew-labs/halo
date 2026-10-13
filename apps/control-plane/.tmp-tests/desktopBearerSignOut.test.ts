import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { expect, test } from "vitest";
import { AuthService } from "../src/auth/AuthService.js";
import { DatabaseService } from "../src/DatabaseService.js";

// The desktop app signs out by posting its bearer token to Better Auth's
// sign-out route from the Electron main process, which sends no Origin header.
const origin = "http://127.0.0.1:8787";
const secret = "test-control-plane-auth-secret-key!";

test("a desktop bearer token is revoked by POST /api/auth/sign-out", async () => {
  const parent = resolve(import.meta.dirname, "../../../tmp/control-plane");
  await fs.mkdir(parent, { recursive: true });
  const appDataDir = await fs.mkdtemp(join(parent, "bearer-sign-out-"));
  const db = await DatabaseService.start({
    type: "sqlite",
    path: join(appDataDir, "control-plane.db"),
  });
  if (db instanceof Error) throw db;
  const auth = await AuthService.start({
    db,
    origin,
    secret,
    googleClientId: "test-google-client-id.apps.googleusercontent.com",
    googleClientSecret: "test-google-client-secret",
  });
  if (auth instanceof Error) throw auth;

  // Sign a user in through Better Auth's test utilities, as ControlPlane.test does.
  const browserHeaders = await (async () => {
    using database = new DatabaseSync(join(appDataDir, "control-plane.db"));
    const helper = betterAuth({
      baseURL: origin,
      secret,
      database,
      plugins: [testUtils()],
    });
    const context = await helper.$context;
    const user = context.test.createUser({
      email: "desktop@example.com",
      name: "Desktop User",
    });
    await context.test.saveUser(user);
    return (await context.test.login({ userId: user.id })).headers;
  })();

  const callback = await auth.completeDesktopSignIn(browserHeaders, {
    callback: "http://127.0.0.1:49152/auth/callback",
    state: "desktop-auth-state-0123456789abcdef",
  });
  if (callback instanceof Error) throw callback;
  const code = callback.searchParams.get("code");
  if (code === null) throw new Error("Desktop sign-in did not return a code");
  const exchanged = await auth.exchangeDesktopAuthCode(code);
  if (exchanged instanceof Error) throw exchanged;

  const bearer = new Headers({ authorization: `Bearer ${exchanged.token}` });
  const before = await auth.getSession(bearer);
  if (before instanceof Error) throw before;
  expect(before?.user.email).toBe("desktop@example.com");

  const signedOut = await auth.handle(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: { authorization: `Bearer ${exchanged.token}` },
    }),
  );
  if (signedOut instanceof Error) throw signedOut;
  expect(signedOut.status).toBe(200);

  const after = await auth.getSession(bearer);
  if (after instanceof Error) throw after;
  expect(after).toBeUndefined();

  const closed = await db.close();
  if (closed instanceof Error) throw closed;
  await fs.rm(appDataDir, { recursive: true, force: true });
});
