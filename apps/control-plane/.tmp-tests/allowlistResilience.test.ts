import fs from "node:fs/promises";
import { join, resolve } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { AuthService } from "../src/auth/AuthService.js";
import { SignInAllowlist } from "../src/auth/SignInAllowlist.js";
import { DatabaseService } from "../src/DatabaseService.js";

const tmpRoot = resolve(import.meta.dirname, "../../../tmp/control-plane");
afterEach(() => {
  vi.restoreAllMocks();
});

test("concurrent requests share one read of the list", async () => {
  let reads = 0;
  let finish: (source: string) => void = () => {};
  const allowlist = new SignInAllowlist({
    read: async () => {
      reads += 1;
      return await new Promise<string>((resolve) => (finish = resolve));
    },
    refreshMs: 60_000,
  });
  const answers = Promise.all([allowlist.allows("a@b.c"), allowlist.allows("x@y.z"), allowlist.allows("a@b.c")]);
  finish("a@b.c");
  expect(await answers).toEqual([true, false, true]);
  expect(reads).toBe(1);
});

test("a hung read times out instead of stalling sign-in", async () => {
  const allowlist = new SignInAllowlist({
    read: async () => await new Promise<string>(() => {}),
    refreshMs: 60_000,
    timeoutMs: 20,
  });
  const result = await allowlist.allows("a@b.c");
  expect(result).toBeInstanceOf(Error);
  expect(String((result as Error).cause)).toContain("timed out after 20ms");
});

test("with a list in hand, a hung refresh falls back to it after the timeout", async () => {
  const now = { value: 0 };
  let slow = false;
  vi.spyOn(console, "error").mockImplementation(() => {});
  const allowlist = new SignInAllowlist({
    read: async () => (slow ? await new Promise<string>(() => {}) : "a@b.c"),
    refreshMs: 10,
    timeoutMs: 20,
    now: () => now.value,
  });
  expect(await allowlist.allows("a@b.c")).toBe(true);
  slow = true;
  now.value = 20;
  expect(await allowlist.allows("a@b.c")).toBe(true);
});

test("failed refreshes back off for the refresh interval and are logged", async () => {
  const now = { value: 0 };
  let reads = 0;
  let source: string | Error = "a@b.c";
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  const allowlist = new SignInAllowlist({
    read: async () => {
      reads += 1;
      return source;
    },
    refreshMs: 60_000,
    now: () => now.value,
  });
  await allowlist.allows("a@b.c");
  source = new Error("outage");
  now.value = 60_000;
  expect(await allowlist.allows("a@b.c")).toBe(true);
  expect(logged).toHaveBeenCalled();
  now.value = 60_001;
  await allowlist.allows("a@b.c");
  await allowlist.allows("a@b.c");
  expect(reads).toBe(2);
  now.value = 120_000;
  await allowlist.allows("a@b.c");
  expect(reads).toBe(3);
});

test("an unreadable list is an error for existing sessions, not a sign-out", async () => {
  await fs.mkdir(tmpRoot, { recursive: true });
  const dir = await fs.mkdtemp(join(tmpRoot, "unreadable-session-"));
  const db = await DatabaseService.start({ type: "sqlite", path: join(dir, "control-plane.db") });
  if (db instanceof Error) throw db;
  let readable = true;
  const auth = await AuthService.start({
    db,
    origin: "http://127.0.0.1:8787",
    secret: "test-control-plane-auth-secret-key!",
    googleClientId: "id",
    googleClientSecret: "secret",
    signInAllowlist: new SignInAllowlist({
      read: async () => (readable ? "michael@libretto.sh" : new Error("secret unavailable")),
      refreshMs: 60_000,
    }),
  });
  if (auth instanceof Error) throw auth;
  // SAFETY: the test reaches AuthService's Better Auth instance to create a
  // session the way the Google callback does.
  const context = await (auth as unknown as { auth: { $context: Promise<{ internalAdapter: {
    createUser(user: object): Promise<{ id: string }>;
    createSession(userId: string): Promise<{ token: string }>;
  } }> } }).auth.$context;
  const user = await context.internalAdapter.createUser({ email: "michael@libretto.sh", name: "Michael", emailVerified: true });
  const { token } = await context.internalAdapter.createSession(user.id);
  // A fresh instance whose first read fails: same database, list never read.
  readable = false;
  const cold = await AuthService.start({
    db,
    origin: "http://127.0.0.1:8787",
    secret: "test-control-plane-auth-secret-key!",
    googleClientId: "id",
    googleClientSecret: "secret",
    signInAllowlist: new SignInAllowlist({ read: async () => new Error("secret unavailable"), refreshMs: 60_000 }),
  });
  if (cold instanceof Error) throw cold;
  const headers = new Headers({ authorization: `Bearer ${token}` });
  expect(await cold.getSession(headers)).toBeInstanceOf(Error);
  expect(await cold.createWorkspaceSocketTicket(headers, "client")).toBeInstanceOf(Error);
  await db.close();
  await fs.rm(dir, { recursive: true, force: true });
});
