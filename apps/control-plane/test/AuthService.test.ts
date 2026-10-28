import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { describe, expect, test } from "vitest";
import { AuthService, authCookieOptions } from "../src/auth/AuthService.js";
import { DatabaseService } from "../src/DatabaseService.js";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { DatabaseSync } from "node:sqlite";
import { Logger } from "@get-halo/logger";

const testAuth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};

const googleSignInSchema = Type.Object({
  url: Type.String({ minLength: 1 }),
  redirect: Type.Literal(true),
});

const testOrigin = "http://127.0.0.1:8787";

const authServiceTest = test.extend<{
  appDataDir: string;
  origin: string;
  auth: AuthService;
}>({
  origin: testOrigin,
  appDataDir: async ({ task }, use) => {
    const parent = resolve(import.meta.dirname, "../../../tmp/control-plane");
    await fs.mkdir(parent, { recursive: true });
    const appDataDir = await fs.mkdtemp(join(parent, `${task.id}-`));
    await use(appDataDir);
    await fs.rm(appDataDir, { recursive: true, force: true });
  },
  auth: async ({ appDataDir, origin }, use) => {
    await using cleanup = new errore.AsyncDisposableStack();

    const db = await DatabaseService.start({
      logger: new Logger(),
      config: { type: "sqlite", path: join(appDataDir, "control-plane.db") },
    });
    if (db instanceof Error) throw db;
    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error) console.warn(closed);
    });

    const auth = await AuthService.start({
      logger: new Logger(),
      db,
      origin,
      secret: testAuth.secret,
      googleClientId: testAuth.googleClientId,
      googleClientSecret: testAuth.googleClientSecret,
    });
    if (auth instanceof Error) throw auth;

    await use(auth);
  },
});

authServiceTest(
  "has no session until Google sign-in completes",
  async ({ auth }) => {
    const session = await auth.getSession({ headers: new Headers() });
    if (session instanceof Error) throw session;
    expect(session).toBeUndefined();
  },
);

authServiceTest("rejects email and password sign-in", async ({ auth }) => {
  const response = await auth.handle(
    new Request(`${testOrigin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: testOrigin,
      },
      body: JSON.stringify({
        email: "user@example.com",
        password: "not-used",
      }),
    }),
  );
  if (response instanceof Error) throw response;
  expect(response.status).toBe(400);
});

authServiceTest(
  "starts Google sign-in with this origin as the callback",
  async ({ auth }) => {
    const response = await auth.handle(
      new Request(`${testOrigin}/api/auth/sign-in/social`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: testOrigin,
        },
        body: JSON.stringify({
          provider: "google",
          callbackURL: testOrigin,
        }),
      }),
    );
    if (response instanceof Error) throw response;
    expect(response.status).toBe(200);

    // SAFETY: JSON.parse is untyped; googleSignInSchema validates the result below.
    const payload = JSON.parse(await response.text()) as unknown;
    if (!Value.Check(googleSignInSchema, payload))
      throw new Error("Google sign-in did not return a redirect URL");

    const google = new URL(payload.url);
    expect(google.origin).toBe("https://accounts.google.com");
    expect(google.pathname).toBe("/o/oauth2/v2/auth");
    expect(google.searchParams.get("client_id")).toBe(testAuth.googleClientId);
    expect(google.searchParams.get("redirect_uri")).toBe(
      `${testOrigin}/api/auth/callback/google`,
    );
    expect(google.searchParams.get("response_type")).toBe("code");
  },
);

describe("on an HTTPS origin", () => {
  authServiceTest.override({ origin: "https://halo.test" });

  authServiceTest(
    "HTTPS deployments use host-only __Host- cookies that sibling hosts cannot shadow",
    async ({ auth, appDataDir, origin }) => {
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
      using database = new DatabaseSync(join(appDataDir, "control-plane.db"));
      const helper = betterAuth({
        baseURL: origin,
        secret: testAuth.secret,
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
      const session = await auth.getSession({
        headers: new Headers({ cookie }),
      });
      expect(session).toMatchObject({ user: { email: "owner@example.com" } });
      const value = cookie.slice(cookie.indexOf("=") + 1);
      for (const name of [
        "better-auth.session_token",
        "__Secure-better-auth.session_token",
        "halo.session_token",
      ])
        expect(
          await auth.getSession({
            headers: new Headers({ cookie: `${name}=${value}` }),
          }),
        ).toBeUndefined();
      // HTTP development keeps Better Auth's defaults.
      expect(authCookieOptions("http://127.0.0.1:4000")).toEqual({});
    },
  );
});
