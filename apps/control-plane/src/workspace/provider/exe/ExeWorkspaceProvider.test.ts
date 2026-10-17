import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import util from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { expect, test, vi } from "vitest";
import { ExeWorkspaceProvider } from "./ExeWorkspaceProvider.js";
import type { WorkspaceProviderAssignment } from "../WorkspaceProviderApi.js";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import type { ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import {
  workspaceRuntimeConfigFileName,
  workspaceRuntimeConfigSchema,
} from "@get-halo/config/workspaceServer";
import * as errore from "errore";
import { ControlPlane } from "../../../server/ControlPlane.js";
import { LocalWorkspaceProvider } from "../local/LocalWorkspaceProvider.js";

const configSchema = Type.Object({
  privateKeyPath: Type.String(),
  knownHostsPath: Type.String(),
  templateVmName: Type.String(),
  gatewaySecret: Type.String({ minLength: 32 }),
});
type ExeTestConfig = Static<typeof configSchema>;

// Actual Exe SSH CLI, used only for guest inspection and disposable VM cleanup.
async function ssh(config: ExeTestConfig, target: string, args: string[]) {
  const result = await util.promisify(childProcess.execFile)(
    "ssh",
    [
      "-F",
      "/dev/null",
      "-i",
      config.privateKeyPath,
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      "IdentityAgent=none",
      "-o",
      "BatchMode=yes",
      "-o",
      "StrictHostKeyChecking=yes",
      "-o",
      `UserKnownHostsFile=${config.knownHostsPath}`,
      target,
      ...args,
    ],
    { encoding: "utf8", timeout: 35_000 },
  );
  return result.stdout;
}

const exeTest = test.extend<{
  config: ExeTestConfig;
  input: WorkspaceProviderAssignment;
  provider: ExeWorkspaceProvider;
  secondProvider: ExeWorkspaceProvider;
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  config: async ({}, use) => {
    const configPath = process.env.HALO_EXE_TEST_CONFIG;
    if (configPath === undefined) throw new Error("Set HALO_EXE_TEST_CONFIG");
    const parsed: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!Value.Check(configSchema, parsed))
      throw new Error("Invalid real Exe test configuration");
    await use(parsed);
  },
  input: async ({ config }, use) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const appDataDir = path.resolve(
      import.meta.dirname,
      "../../../../../../tmp/exe-runtime-tests",
      crypto.randomUUID(),
    );
    cleanup.defer(
      async () => await fs.rm(appDataDir, { recursive: true, force: true }),
    );
    const authConfig = {
      secret: "real-exe-workspace-auth-test-secret",
      googleClientId: "exe-test.apps.googleusercontent.com",
      googleClientSecret: "unused-google-test-secret",
    };
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        port: 0,
        appDataDir,
        auth: authConfig,
      },
      workspaceProvider: new LocalWorkspaceProvider({ appDataDir }),
      webRoot: appDataDir,
    });
    if (plane instanceof Error) throw plane;
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) console.warn(closed);
    });
    using database = new DatabaseSync(
      path.join(appDataDir, "control-plane.db"),
    );
    const auth = betterAuth({
      baseURL: plane.origin,
      secret: authConfig.secret,
      database,
      plugins: [testUtils()],
    });
    const context = await auth.$context;
    const owner = context.test.createUser();
    await context.test.saveUser(owner);
    const login = await context.test.login({ userId: owner.id });
    // SAFETY: The real control plane implements this client contract at /rpc.
    const rpc = createORPCClient(
      new RPCLink({
        origin: plane.origin,
        url: "/rpc",
        headers: login.headers,
      }),
    ) as ControlPlaneClient;
    const workspace = await rpc.workspace.ensure();
    const runtime: unknown = JSON.parse(
      await fs.readFile(
        path.join(appDataDir, workspaceRuntimeConfigFileName),
        "utf8",
      ),
    );
    if (!Value.Check(workspaceRuntimeConfigSchema, runtime))
      throw new Error("Invalid runtime assignment");
    const input = { workspaceId: workspace.id, ownerUserId: owner.id, runtime };
    await use(input);
    // Delete exactly this fixture's clone, even if it is still paused.
    const vmName = `halo-${workspace.id}`;
    const raw = await ssh(config, "exe.dev", ["ls", vmName, "--json"]);
    const listed: unknown = JSON.parse(raw);
    if (
      !Value.Check(
        Type.Object({
          vms: Type.Array(Type.Object({ vm_name: Type.String() })),
        }),
        listed,
      )
    )
      throw new Error("Invalid Exe VM cleanup lookup");
    if (listed.vms.some((vm) => vm.vm_name === vmName))
      await ssh(config, "exe.dev", ["rm", vmName, "--json"]);
  },
  provider: async ({ config }, use) =>
    await use(new ExeWorkspaceProvider(config)),
  secondProvider: async ({ config }, use) =>
    await use(new ExeWorkspaceProvider(config)),
});

const removalTest = test.extend<{ provider: ExeWorkspaceProvider }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  provider: async ({}, use) => {
    const directory = path.resolve(
      import.meta.dirname,
      "../../../../../../tmp/exe-removal-permissions",
      crypto.randomUUID(),
    );
    await fs.mkdir(directory, { recursive: true });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(
      async () => await fs.rm(directory, { recursive: true, force: true }),
    );
    const privateKeyPath = path.join(directory, "id_ed25519");
    await util.promisify(childProcess.execFile)("ssh-keygen", [
      "-t",
      "ed25519",
      "-N",
      "",
      "-f",
      privateKeyPath,
    ]);
    const vms = new Set(["halo-removal-test"]);
    // Model Exe's command authorization at the external HTTPS boundary, using
    // the actual signed credential rather than replacing the provider or signer.
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        expect(url).toBe("https://exe.dev/exec");
        const token = new Headers(init?.headers)
          .get("authorization")
          ?.split(".")[1];
        if (token === undefined) throw new Error("Missing Exe token payload");
        const permissions: unknown = JSON.parse(
          Buffer.from(token, "base64url").toString(),
        );
        const schema = Type.Object({
          exp: Type.Number(),
          cmds: Type.Array(Type.String()),
        });
        if (!Value.Check(schema, permissions))
          throw new Error("Invalid Exe permissions");
        const command = /^'([a-z]+)' '([^']+)'$/u.exec(String(init?.body));
        if (command === null) throw new Error("Unexpected Exe command");
        const [, name = "", vmName = ""] = command;
        if (!permissions.cmds.includes(name))
          return new Response("Command not permitted", { status: 403 });
        if (name === "ls")
          return Response.json({
            vms: vms.has(vmName)
              ? [{ vm_name: vmName, status: "running", proxy_share: "private" }]
              : [],
          });
        if (name !== "rm") throw new Error("Unexpected Exe command");
        vms.delete(vmName);
        return new Response("Removed");
      });
    cleanup.defer(() => fetch.mockRestore());
    await use(
      new ExeWorkspaceProvider({
        privateKeyPath,
        templateVmName: "unused",
        gatewaySecret: "test-gateway-secret",
      }),
    );
  },
});

// Durable: removal must work with the signed command permissions used in staging.
removalTest(
  "removes an app VM with its API credential and tolerates a retry",
  async ({ provider }) => {
    const input = { workspaceId: "removal-test", ownerUserId: "owner" };
    expect(await provider.remove(input)).toBeUndefined();
    expect(await provider.getConnection(input)).toBeUndefined();
    expect(await provider.remove(input)).toBeUndefined();
  },
);

// No fallback host: this test provisions a real, billed Exe VM from an empty template.
exeTest.skipIf(process.env.HALO_EXE_TEST_CONFIG === undefined)(
  "provisions one private Exe desktop and preserves its boot across pause/resume",
  async ({ config, input, provider, secondProvider }) => {
    expect(await provider.getConnection(input)).toBeUndefined();
    expect(
      await Promise.all([
        provider.ensure(input),
        provider.ensure(input),
        secondProvider.ensure(input),
      ]),
    ).toEqual([undefined, undefined, undefined]);

    const connection = await provider.getConnection(input);
    if (connection instanceof Error || connection === undefined)
      throw connection;
    if (connection.authorization.type !== "headers")
      throw new Error("Expected private Exe ingress credentials");
    const headers = connection.authorization.value;
    const desktopUrl = `${connection.origin}/desktop/`;
    const desktopStatus = async () => {
      const response = await fetch(desktopUrl, {
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      await response.arrayBuffer();
      return response.status;
    };
    await expect.poll(desktopStatus, { timeout: 60_000 }).toBe(200);
    const rejected = await fetch(desktopUrl, {
      headers: { ...headers, authorization: "Bearer wrong-workspace" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
    await rejected.arrayBuffer();
    expect(rejected.status).toBe(401);

    const vmName = `halo-${input.workspaceId}`;
    const guest = `${vmName}.exe.xyz`;
    const assigned: unknown = JSON.parse(
      await ssh(config, guest, ["sudo cat /etc/halo/workspace-server.json"]),
    );
    const assignedSchema = Type.Object({
      runtime: workspaceRuntimeConfigSchema,
    });
    if (!Value.Check(assignedSchema, assigned))
      throw new Error("Missing guest runtime settings");
    if (JSON.stringify(assigned.runtime) !== JSON.stringify(input.runtime))
      throw new Error("Guest runtime assignment mismatch");
    const identify = async () => {
      const response = await fetch(
        `${assigned.runtime.origin}/api/workspace-runtime/identity`,
        {
          headers: { authorization: `Bearer ${assigned.runtime.token}` },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ workspaceId: input.workspaceId });
    };
    await identify();
    const bootId = await ssh(config, guest, [
      "cat /proc/sys/kernel/random/boot_id",
    ]);
    expect(await provider.pause(input)).toBeUndefined();
    expect(await provider.getConnection(input)).toEqual(connection);
    const paused: unknown = JSON.parse(
      await ssh(config, "exe.dev", ["ls", vmName, "--json"]),
    );
    expect(paused).toMatchObject({
      vms: [
        {
          vm_name: vmName,
          status: expect.stringMatching(/^(paused|suspended)$/u),
        },
      ],
    });
    expect(await provider.getStatus(input)).toBe("paused");
    // Opening a workspace uses ensure, which must wake it before assignment.
    expect(await secondProvider.ensure(input)).toBeUndefined();
    expect(await provider.getStatus(input)).toBe("running");
    await expect.poll(desktopStatus, { timeout: 60_000 }).toBe(200);
    expect(
      await ssh(config, guest, ["cat /proc/sys/kernel/random/boot_id"]),
    ).toBe(bootId);
    const guestTime = Number(await ssh(config, guest, ["date +%s"])) * 1000;
    expect(Math.abs(Date.now() - guestTime)).toBeLessThan(10_000);
    await identify();
    expect(await provider.pause(input)).toBeUndefined();
    expect(await provider.resume(input)).toBeUndefined();
    await expect.poll(desktopStatus, { timeout: 60_000 }).toBe(200);
  },
  180_000,
);

exeTest.skipIf(process.env.HALO_EXE_TEST_CONFIG === undefined)(
  "assigns a pre-copied private workspace without replacing its saved home",
  async ({ config, input, provider }) => {
    const vmName = `halo-${input.workspaceId}`;
    await ssh(config, "exe.dev", [
      "cp",
      config.templateVmName,
      vmName,
      "--copy-tags=false",
      "--json",
    ]);
    const guest = `${vmName}.exe.xyz`;
    await ssh(config, guest, [
      "sudo test ! -f /etc/halo/assignment.json && printf 'Saved before assignment\\n' | sudo tee /var/lib/halo/home/documents/migration-check.txt >/dev/null && sudo chown 1000:1000 /var/lib/halo/home/documents/migration-check.txt",
    ]);
    expect(await provider.pause(input)).toBeUndefined();
    expect(await provider.ensure(input)).toBeUndefined();
    const workspaceTag = "halo-migration-assignment-test";
    const taggedProvider = new ExeWorkspaceProvider({
      ...config,
      workspaceTag,
    });
    expect(
      await taggedProvider.ensure({ ...input, ownerUserId: "another-owner" }),
    ).toBeInstanceOf(Error);
    expect(
      JSON.parse(await ssh(config, "exe.dev", ["ls", vmName, "--json"])),
    ).not.toMatchObject({
      vms: [{ tags: expect.arrayContaining([workspaceTag]) }],
    });
    expect(await taggedProvider.ensure(input)).toBeUndefined();
    expect(
      JSON.parse(await ssh(config, "exe.dev", ["ls", vmName, "--json"])),
    ).toMatchObject({
      vms: [{ tags: expect.arrayContaining([workspaceTag]) }],
    });
    expect(
      await ssh(config, guest, [
        "sudo cat /var/lib/halo/home/documents/migration-check.txt",
      ]),
    ).toBe("Saved before assignment\n");
    const connection = await provider.getConnection(input);
    if (connection instanceof Error || connection === undefined)
      throw connection;
    if (connection.authorization.type !== "headers")
      throw new Error("Expected private Exe ingress credentials");
    const headers = connection.authorization.value;
    await expect
      .poll(
        async () => {
          const response = await fetch(`${connection.origin}/desktop/`, {
            headers,
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
          });
          await response.arrayBuffer();
          return response.status;
        },
        { timeout: 60_000 },
      )
      .toBe(200);
    expect(await provider.pause(input)).toBeUndefined();
    expect(await provider.getStatus(input)).toBe("paused");
  },
  180_000,
);
