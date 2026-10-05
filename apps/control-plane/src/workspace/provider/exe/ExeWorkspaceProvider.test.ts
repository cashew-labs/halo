import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import util from "node:util";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { expect, test } from "vitest";
import { ExeWorkspaceProvider } from "./ExeWorkspaceProvider.js";
import type { WorkspaceProviderInput } from "../WorkspaceProviderApi.js";

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
  input: WorkspaceProviderInput;
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
    const workspaceId = crypto.randomUUID();
    await use({ workspaceId, ownerUserId: `exe-test-${workspaceId}` });
    // Delete exactly this fixture's clone, even if it is still paused.
    const vmName = `halo-${workspaceId}`;
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
    const bootId = await ssh(config, guest, [
      "cat /proc/sys/kernel/random/boot_id",
    ]);
    expect(await provider.pause(input)).toBeUndefined();
    expect(await provider.getConnection(input)).toEqual(connection);
    const paused: unknown = JSON.parse(
      await ssh(config, "exe.dev", ["ls", vmName, "--json"]),
    );
    expect(paused).toMatchObject({
      vms: [{ vm_name: vmName, status: "paused" }],
    });
    expect(await provider.resume(input)).toBeUndefined();
    await expect.poll(desktopStatus, { timeout: 60_000 }).toBe(200);
    expect(
      await ssh(config, guest, ["cat /proc/sys/kernel/random/boot_id"]),
    ).toBe(bootId);
  },
  180_000,
);
