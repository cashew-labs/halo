import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { expect, test } from "vitest";
import { AuthService } from "../src/auth/AuthService.js";
import { DatabaseService } from "../src/DatabaseService.js";

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
  auth: AuthService;
}>({
  appDataDir: async ({ task }, use) => {
    const parent = resolve(import.meta.dirname, "../../../tmp/control-plane");
    await fs.mkdir(parent, { recursive: true });
    const appDataDir = await fs.mkdtemp(join(parent, `${task.id}-`));
    await use(appDataDir);
    await fs.rm(appDataDir, { recursive: true, force: true });
  },
  auth: async ({ appDataDir }, use) => {
    await using cleanup = new errore.AsyncDisposableStack();

    const db = await DatabaseService.start({
      type: "sqlite",
      path: join(appDataDir, "control-plane.db"),
    });
    if (db instanceof Error) throw db;
    cleanup.defer(async () => {
      const closed = await db.close();
      if (closed instanceof Error) console.warn(closed);
    });

    const auth = await AuthService.start({
      db,
      origin: testOrigin,
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
    const session = await auth.getSession(new Headers());
    if (session instanceof Error) throw session;
    expect(session).toBeUndefined();
  },
);

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
