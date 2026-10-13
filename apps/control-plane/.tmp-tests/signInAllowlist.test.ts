import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { expect, test } from "vitest";
import { AuthService } from "../src/auth/AuthService.js";
import { SignInAllowlist } from "../src/auth/SignInAllowlist.js";
import { signInHooks } from "../src/auth/signInHooks.js";
import { DatabaseService } from "../src/DatabaseService.js";

const tmpRoot = resolve(import.meta.dirname, "../../../tmp/control-plane");

function list(source: string | Error, now = { value: 0 }) {
  let reads = 0;
  const allowlist = new SignInAllowlist({
    read: async () => {
      reads += 1;
      return source;
    },
    refreshMs: 60_000,
    now: () => now.value,
  });
  return { allowlist, reads: () => reads };
}

test("parses newline- and comma-separated emails, case-insensitively", async () => {
  const { allowlist } = list(" Michael@Libretto.sh \ntanishq@libretto.sh, a@b.c\n\n");
  expect(await allowlist.allows("michael@libretto.sh")).toBe(true);
  expect(await allowlist.allows("TANISHQ@libretto.sh")).toBe(true);
  expect(await allowlist.allows("a@b.c")).toBe(true);
  expect(await allowlist.allows("someone@example.com")).toBe(false);
});

test("re-reads the source only after the refresh interval", async () => {
  const now = { value: 0 };
  const { allowlist, reads } = list("a@b.c", now);
  await allowlist.allows("a@b.c");
  now.value = 59_999;
  await allowlist.allows("a@b.c");
  expect(reads()).toBe(1);
  now.value = 60_000;
  await allowlist.allows("a@b.c");
  expect(reads()).toBe(2);
});

test("refuses everyone when the list has never been read", async () => {
  const { allowlist } = list(new Error("secret missing"));
  const result = await allowlist.allows("a@b.c");
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain("could not be read");
});

test("keeps the last good list through a failed refresh", async () => {
  const now = { value: 0 };
  let source: string | Error = "a@b.c";
  const allowlist = new SignInAllowlist({
    read: async () => source,
    refreshMs: 1,
    now: () => now.value,
  });
  expect(await allowlist.allows("a@b.c")).toBe(true);
  source = new Error("transient");
  now.value = 10;
  expect(await allowlist.allows("a@b.c")).toBe(true);
  expect(await allowlist.allows("x@y.z")).toBe(false);
});

test("no allowlist means no hooks", () => {
  expect(
    signInHooks({ allowlist: undefined, findUserEmail: async () => undefined }),
  ).toBeUndefined();
});

async function authWith(
  allowlist: SignInAllowlist,
  name: string,
  failLookup = false,
) {
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(join(tmpRoot, `${name}-`));
  const database = new DatabaseSync(join(dir, "auth.db"));
  const options = {
    baseURL: "http://127.0.0.1:8787",
    secret: "test-control-plane-auth-secret-key!",
    database,
    databaseHooks: signInHooks({
      allowlist,
      findUserEmail: async (userId: string) => {
        if (failLookup) return new Error("database unavailable");
        // SAFETY: the test schema stores email as text.
        const row = database
          .prepare('SELECT email FROM "user" WHERE id = ?')
          .get(userId) as { email: string } | undefined;
        return row?.email;
      },
    }),
  };
  const { runMigrations } = await getMigrations(options);
  await runMigrations();
  const context = await betterAuth(options).$context;
  return {
    adapter: context.internalAdapter,
    close: async () => {
      database.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}

test("an allowed email can be created and signed in", async () => {
  const { allowlist } = list("michael@libretto.sh");
  const { adapter, close } = await authWith(allowlist, "allowed");
  const user = await adapter.createUser({ email: "michael@libretto.sh", name: "Michael", emailVerified: true });
  const session = await adapter.createSession(user.id);
  expect(session.userId).toBe(user.id);
  await close();
});

test("an email not on the list cannot create an account", async () => {
  const { allowlist } = list("michael@libretto.sh");
  const { adapter, close } = await authWith(allowlist, "new-user");
  await expect(
    adapter.createUser({ email: "someone@example.com", name: "Someone", emailVerified: true }),
  ).rejects.toThrow("limited to invited accounts");
  await close();
});

test("an existing account removed from the list cannot start a session", async () => {
  const source = { value: "someone@example.com" };
  const allowlist = new SignInAllowlist({ read: async () => source.value, refreshMs: 0 });
  const { adapter, close } = await authWith(allowlist, "removed");
  const user = await adapter.createUser({ email: "someone@example.com", name: "Someone", emailVerified: true });
  source.value = "michael@libretto.sh";
  await expect(adapter.createSession(user.id)).rejects.toThrow("limited to invited accounts");
  await close();
});

test("an unreadable list refuses sign-in", async () => {
  const { allowlist } = list(new Error("secret missing"));
  const { adapter, close } = await authWith(allowlist, "unreadable");
  await expect(
    adapter.createUser({ email: "michael@libretto.sh", name: "Michael", emailVerified: true }),
  ).rejects.toThrow("limited to invited accounts");
  await close();
});

test("AuthService starts with an allowlist", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(join(tmpRoot, "service-"));
  const db = await DatabaseService.start({ type: "sqlite", path: join(dir, "control-plane.db") });
  if (db instanceof Error) throw db;
  const auth = await AuthService.start({
    db,
    origin: "http://127.0.0.1:8787",
    secret: "test-control-plane-auth-secret-key!",
    googleClientId: "id",
    googleClientSecret: "secret",
    signInAllowlist: list("michael@libretto.sh").allowlist,
  });
  expect(auth).not.toBeInstanceOf(Error);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a failed user lookup refuses the session", async () => {
  const { allowlist } = list("michael@libretto.sh");
  const { adapter, close } = await authWith(allowlist, "lookup", true);
  const user = await adapter.createUser({
    email: "michael@libretto.sh",
    name: "Michael",
    emailVerified: true,
  });
  await expect(adapter.createSession(user.id)).rejects.toThrow(
    "limited to invited accounts",
  );
  await close();
});

test("AuthService refuses new accounts and drops sessions once an email leaves the list", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(join(tmpRoot, "service-hooks-"));
  const db = await DatabaseService.start({ type: "sqlite", path: join(dir, "control-plane.db") });
  if (db instanceof Error) throw db;
  const source = { value: "michael@libretto.sh" };
  const auth = await AuthService.start({
    db,
    origin: "http://127.0.0.1:8787",
    secret: "test-control-plane-auth-secret-key!",
    googleClientId: "id",
    googleClientSecret: "secret",
    signInAllowlist: new SignInAllowlist({ read: async () => source.value, refreshMs: 0 }),
  });
  if (auth instanceof Error) throw auth;
  // SAFETY: the test reaches AuthService's Better Auth instance to create users
  // and sessions the way the Google callback does, running the same hooks.
  const context = await (auth as unknown as { auth: { $context: Promise<{ internalAdapter: {
    createUser(user: object): Promise<{ id: string }>;
    createSession(userId: string): Promise<{ token: string }>;
  } }> } }).auth.$context;

  const outsider = await context.internalAdapter
    .createUser({ email: "someone@example.com", name: "Someone", emailVerified: true })
    .catch((error: unknown) => error);
  expect(outsider).toMatchObject({ body: { code: "NOT_INVITED" } });

  const user = await context.internalAdapter.createUser({
    email: "michael@libretto.sh",
    name: "Michael",
    emailVerified: true,
  });
  const session = await context.internalAdapter.createSession(user.id);
  const headers = new Headers({ authorization: `Bearer ${session.token}` });
  const before = await auth.getSession(headers);
  expect(before).toMatchObject({ user: { email: "michael@libretto.sh" } });

  source.value = "tanishq@libretto.sh";
  expect(await auth.getSession(headers)).toBeUndefined();
  expect(await auth.createWorkspaceSocketTicket(headers, "client")).toBeUndefined();
  await expect(context.internalAdapter.createSession(user.id)).rejects.toMatchObject({
    body: { code: "NOT_INVITED" },
  });

  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("a broken user lookup in AuthService refuses the session", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(join(tmpRoot, "service-lookup-"));
  const db = await DatabaseService.start({ type: "sqlite", path: join(dir, "control-plane.db") });
  if (db instanceof Error) throw db;
  const auth = await AuthService.start({
    db,
    origin: "http://127.0.0.1:8787",
    secret: "test-control-plane-auth-secret-key!",
    googleClientId: "id",
    googleClientSecret: "secret",
    signInAllowlist: new SignInAllowlist({ read: async () => "michael@libretto.sh", refreshMs: 0 }),
  });
  if (auth instanceof Error) throw auth;
  // SAFETY: as above, the test reaches AuthService's Better Auth instance.
  const context = await (auth as unknown as { auth: { $context: Promise<{ internalAdapter: {
    createUser(user: object): Promise<{ id: string }>;
    createSession(userId: string): Promise<{ token: string }>;
  } }> } }).auth.$context;
  const user = await context.internalAdapter.createUser({
    email: "michael@libretto.sh",
    name: "Michael",
    emailVerified: true,
  });
  // SAFETY: DatabaseService uses SQLite here.
  (db.client as DatabaseSync).exec('ALTER TABLE "user" RENAME TO user_unavailable');
  await expect(context.internalAdapter.createSession(user.id)).rejects.toMatchObject({
    body: { code: "NOT_INVITED" },
  });
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
