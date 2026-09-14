import { execa } from "execa";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { scaffoldExtension } from "@get-halo/extension-tools/scaffold";
import { Cli, z } from "incur";
import * as errore from "errore";
import { connectHalo, type HaloRpcEnv } from "./connectHalo.js";
import { packDevelopmentExtensions } from "./extensionDevelopment.js";

class ExtensionCommandError extends errore.createTaggedError({
  name: "ExtensionCommandError",
  message: "Extension command failed: $detail",
}) {}

const env = z.object({
  HALO_RPC_FILE: z.string().optional(),
  HALO_USER_DATA: z.string().optional(),
  HALO_EXTENSION_SOURCE: z.string().optional(),
});

export const extension = Cli.create("extension", {
  description: "Create and load standalone workspace extensions",
})
  .command("new", {
    description: "Scaffold an extension and install its dependencies",
    args: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
    env,
    async run(c) {
      const workspaceRoot = await getWorkspaceRoot(c.env);
      if (workspaceRoot instanceof Error)
        return c.error({ code: "EXTENSION", message: workspaceRoot.message });
      const created = await createExtension({
        workspaceRoot,
        id: c.args.id,
        sourceDirectory: c.env.HALO_EXTENSION_SOURCE,
      });
      if (created instanceof Error) {
        return c.error({ code: "EXTENSION", message: created.message });
      }
      return c.ok(created);
    },
  })
  .command("update", {
    description:
      "Install the local SDK and build tools, then rebuild an extension (development)",
    args: z.object({ id: z.string().regex(/^[a-z][a-z0-9-]*$/) }),
    env,
    async run(c) {
      if (c.env.HALO_EXTENSION_SOURCE === undefined)
        return c.error({
          code: "DEVELOPMENT_ONLY",
          message: "Use the workspace's halo command from the development app.",
        });
      const workspaceRoot = await getWorkspaceRoot(c.env);
      if (workspaceRoot instanceof Error)
        return c.error({ code: "EXTENSION", message: workspaceRoot.message });
      const packages = await packDevelopmentExtensions({
        sourceDirectory: c.env.HALO_EXTENSION_SOURCE,
        workspaceRoot,
      });
      if (packages instanceof Error)
        return c.error({ code: "EXTENSION", message: packages.message });
      const directory = join(workspaceRoot, ".halo", "extensions", c.args.id);
      for (const args of [
        ["install", "--save", `@get-halo/extension-sdk@${packages.sdk}`],
        [
          "install",
          "--save-dev",
          `@get-halo/extension-tools@${packages.tools}`,
        ],
        ["run", "typecheck"],
        ["run", "build"],
      ]) {
        const result = await runNpm(directory, args);
        if (result instanceof Error)
          return c.error({ code: "EXTENSION", message: result.message });
      }
      return c.ok({
        id: c.args.id,
        directory,
        next: "Restart the workspace server to load the rebuilt extension process.",
      });
    },
  })
  .command("reload", {
    description:
      "Discover built extensions and stop servers for deleted extensions",
    env,
    async run(c) {
      const connected = await connectHalo(c.env);
      if (connected instanceof Error) {
        return c.error({ code: "NOT_RUNNING", message: connected.message });
      }
      const reloaded = await connected.client.extensions
        .reload()
        .catch(
          (cause) =>
            new ExtensionCommandError({ detail: "reload extensions", cause }),
        );
      if (reloaded instanceof Error) {
        return c.error({ code: "EXTENSION", message: reloaded.message });
      }
      return c.ok(reloaded);
    },
  });

async function createExtension({
  workspaceRoot,
  id,
  sourceDirectory,
}: {
  workspaceRoot: string;
  id: string;
  sourceDirectory: string | undefined;
}) {
  const parent = join(workspaceRoot, ".halo", "extensions");
  const made = await mkdir(parent, { recursive: true }).catch(
    (cause) =>
      new ExtensionCommandError({
        detail: "create extensions directory",
        cause,
      }),
  );
  if (made instanceof Error) return made;

  const packages =
    sourceDirectory === undefined
      ? undefined
      : await packDevelopmentExtensions({ sourceDirectory, workspaceRoot });
  if (packages instanceof Error) return packages;
  const directory = join(parent, id);
  const scaffolded = await scaffoldExtension({
    directory,
    name: id,
    packages,
  });
  if (scaffolded instanceof Error) return scaffolded;

  const installed = await runNpm(directory, ["install"]);
  if (installed instanceof Error) return installed;
  return { id, directory };
}

async function runNpm(directory: string, args: string[]) {
  return await execa(
    "npm",
    [
      ...args,
      "--workspaces=false",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd: directory },
  ).catch(
    (cause) =>
      new ExtensionCommandError({
        detail: `${args.join(" ")}: ${cause.message}`,
        cause,
      }),
  );
}

async function getWorkspaceRoot(environment: HaloRpcEnv) {
  const connected = await connectHalo(environment);
  if (connected instanceof Error) return connected;
  const workspace = await connected.client.workspace
    .get()
    .catch(
      (cause) => new ExtensionCommandError({ detail: "read workspace", cause }),
    );
  if (workspace instanceof Error) return workspace;
  if (workspace === undefined)
    return new ExtensionCommandError({ detail: "Open a workspace first" });
  return workspace.workspaceRoot;
}
