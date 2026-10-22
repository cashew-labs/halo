import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import { expect, vi } from "vitest";
import {
  DeviceHost,
  type DevicePermissions,
  type DeviceSettings,
} from "@get-halo/device-host";
import {
  devicePermissionOf,
  sessionToolExecutions,
  type DeviceSummary,
} from "@get-halo/client";
import { m } from "@get-halo/shared/testing";
import type { TestServer } from "./TestServer.js";
import { serverTest } from "./serverTest.js";

async function connectDevice(
  server: TestServer,
  cleanup: errore.AsyncDisposableStack,
  permissions: (home: string) => DevicePermissions = () => ({
    grants: [],
    commandsAllowed: false,
  }),
) {
  const home = path.join(server.harness.paths.root, "device-home");
  await fs.mkdir(path.join(home, "Documents"), { recursive: true });
  await fs.mkdir(path.join(home, ".ssh"), { recursive: true });
  await fs.writeFile(path.join(home, "Documents", "notes.md"), "Buy milk\n");
  await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "key\n");
  const allowed = permissions(home);
  const settings: DeviceSettings = {
    id: "8a0e7c63-5c2f-4f3c-9d4c-3c6a8f0f1d11",
    name: "Studio Mac",
    enabled: true,
    files: { grants: allowed.grants },
    commands: { allowed: allowed.commandsAllowed },
  };
  const host = new DeviceHost({
    settings,
    home,
    getTransport: async () => await Promise.resolve(server.rendererTransport),
    logger: { info: () => undefined, warn: () => undefined },
    savePermissions: async () => await Promise.resolve(),
  });
  host.start();
  cleanup.defer(async () => await host.stop());
  await expect
    .poll(async () => await listDevices(server))
    .toMatchObject([{ name: "Studio Mac", online: true }]);
  return { host, home, settings };
}

/** Allows read and write in the device's Documents folder. */
const documentsWritable = (home: string): DevicePermissions => ({
  grants: [{ path: path.join(home, "Documents"), access: "write" }],
  commandsAllowed: false,
});

async function listDevices(server: TestServer) {
  const listed = await server.rpc.testApi.invokeTool({
    path: "devices.list",
    input: {},
  });
  // SAFETY: devices.list returns the summaries from DeviceService.list.
  return (listed as { devices: DeviceSummary[] }).devices;
}

serverTest(
  "a chat card asks for a folder, and the agent's retry reads it after the person allows it",
  async ({ server, llm }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const { host, home } = await connectDevice(server, cleanup);
    const session = await server.rpc.thread.new();
    const prompting = server.promptAndWait({
      ...session,
      text: "What is on my grocery list?",
    });
    const js = `await tools.devices.files.read({ device: "Studio Mac", path: "~/Documents/notes.md" })`;
    await llm.respond(
      m.tool.start("exec", { id: "read-request", arguments: { js } }),
    );
    await llm.respond(m.assistant("Please allow access to Documents."));
    await prompting;

    const [approval] = sessionToolExecutions(
      await server.rpc.thread.snapshot(session),
    ).flatMap((execution) =>
      execution.type === "exec" ? execution.approvals : [],
    );
    expect(approval).toMatchObject({
      toolPath: "devices.files.read",
      status: "pending",
    });
    const permission = devicePermissionOf(approval!);
    expect(permission).toEqual({
      deviceId: "8a0e7c63-5c2f-4f3c-9d4c-3c6a8f0f1d11",
      deviceName: "Studio Mac",
      deviceHome: home,
      request: {
        kind: "folder",
        folder: path.join(home, "Documents"),
        access: "read",
        path: path.join(home, "Documents", "notes.md"),
      },
    });

    // The desktop app records the grant on the device, then answers the card.
    await host.allow({ request: permission!.request, access: "read" });
    await server.rpc.thread.respondToToolApproval({
      ...session,
      approvalId: approval!.id,
      decision: "allow",
    });
    await llm.respond(
      m.tool.start("exec", { id: "read-retry", arguments: { js } }),
    );
    const answer = vi.fn();
    await llm.respond(({ messages }) => {
      answer(JSON.stringify(messages.at(-1)));
      return m.assistant("Your list says to buy milk.");
    });
    await expect.poll(() => answer.mock.calls.length).toBe(1);
    expect(answer.mock.calls[0]?.[0]).toContain("Buy milk");
    await expect
      .poll(async () =>
        sessionToolExecutions(await server.rpc.thread.snapshot(session))
          .flatMap((execution) =>
            execution.type === "exec" ? execution.approvals : [],
          )
          .map((entry) => entry.status),
      )
      .toEqual(["allowed"]);
  },
);

serverTest(
  "the agent reads, edits, and writes files in an allowed folder",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const { home } = await connectDevice(server, cleanup, documentsWritable);

    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.files.read",
        input: { device: "studio mac", path: "~/Documents/notes.md" },
      }),
    ).resolves.toEqual({
      device: "Studio Mac",
      path: path.join(home, "Documents/notes.md"),
      text: "Buy milk\n",
    });
    await server.rpc.testApi.invokeTool({
      path: "devices.files.edit",
      input: {
        device: "Studio Mac",
        path: "Documents/notes.md",
        oldText: "milk",
        newText: "oat milk",
      },
    });
    expect(
      await fs.readFile(path.join(home, "Documents/notes.md"), "utf8"),
    ).toBe("Buy oat milk\n");
    await server.rpc.testApi.invokeTool({
      path: "devices.files.write",
      input: {
        device: "Studio Mac",
        path: "~/Documents/plans/today.md",
        content: "Call the bank\n",
      },
    });
    expect(
      await fs.readFile(path.join(home, "Documents/plans/today.md"), "utf8"),
    ).toBe("Call the bank\n");
  },
);

serverTest(
  "copies files between a computer and the workspace",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const { home } = await connectDevice(server, cleanup, documentsWritable);
    const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]);
    await fs.writeFile(path.join(home, "Documents/photo.png"), image);

    const copied = await server.rpc.testApi.invokeTool({
      path: "devices.files.copyToWorkspace",
      input: { device: "Studio Mac", path: "~/Documents/photo.png" },
    });
    expect(copied).toMatchObject({
      workspacePath: expect.stringMatching(
        /^\.halo\/device-files\/.+\/photo\.png$/,
      ),
      size: image.length,
    });
    // SAFETY: Matched above.
    const { workspacePath } = copied as { workspacePath: string };
    expect(
      await fs.readFile(
        path.join(server.harness.paths.workspace, workspacePath),
      ),
    ).toEqual(image);

    await server.harness.files.write({
      path: "workspace/report.txt",
      content: "Quarterly report\n",
    });
    await server.rpc.testApi.invokeTool({
      path: "devices.files.copyFromWorkspace",
      input: {
        device: "Studio Mac",
        workspacePath: "report.txt",
        path: "~/Documents/report.txt",
      },
    });
    expect(
      await fs.readFile(path.join(home, "Documents/report.txt"), "utf8"),
    ).toBe("Quarterly report\n");
  },
);

serverTest(
  "without permission nothing runs, and credential folders are always refused",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const { home } = await connectDevice(server, cleanup, (root) => ({
      grants: [{ path: root, access: "read" }],
      commandsAllowed: false,
    }));
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.files.write",
        input: {
          device: "Studio Mac",
          path: "~/Documents/notes.md",
          content: "changed",
        },
      }),
    ).rejects.toThrow(/needs permission/);
    expect(
      await fs.readFile(path.join(home, "Documents/notes.md"), "utf8"),
    ).toBe("Buy milk\n");
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.files.read",
        input: { device: "Studio Mac", path: "~/.ssh/id_ed25519" },
      }),
    ).rejects.toThrow(/protected_path/);
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.shell.run",
        input: { device: "Studio Mac", command: "touch ran" },
      }),
    ).rejects.toThrow(/needs permission/);
    await expect(fs.stat(path.join(home, "ran"))).rejects.toThrow();
  },
);

serverTest(
  "the agent runs commands on a computer that allows them",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const { home } = await connectDevice(server, cleanup, () => ({
      grants: [],
      commandsAllowed: true,
    }));
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.shell.run",
        input: {
          device: "Studio Mac",
          command: "pwd; cat Documents/notes.md; exit 2",
        },
      }),
    ).resolves.toEqual({
      device: "Studio Mac",
      code: 2,
      timedOut: false,
      stdout: `${home}\nBuy milk\n`,
      stderr: "",
      truncated: false,
    });
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.shell.run",
        input: {
          device: "Studio Mac",
          command: "pwd",
          cwd: "~/Documents",
          timeoutMs: 5_000,
        },
      }),
    ).resolves.toMatchObject({ stdout: `${path.join(home, "Documents")}\n` });
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.shell.run",
        input: { device: "Studio Mac", command: "sleep 30", timeoutMs: 300 },
      }),
    ).resolves.toMatchObject({ timedOut: true });
  },
);

serverTest("turning the computer off disconnects it", async ({ server }) => {
  await using cleanup = new errore.AsyncDisposableStack();
  const { host, settings } = await connectDevice(
    server,
    cleanup,
    documentsWritable,
  );
  host.update({ ...settings, enabled: false });
  await expect
    .poll(async () => await listDevices(server))
    .toMatchObject([{ online: false }]);
  await expect(
    server.rpc.testApi.invokeTool({
      path: "devices.files.read",
      input: { device: "Studio Mac", path: "~/Documents/notes.md" },
    }),
  ).rejects.toThrow(/Device "Studio Mac" is offline/);
});

serverTest(
  "reports an unknown device by name with the devices that are online",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    await connectDevice(server, cleanup);
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.files.list",
        input: { device: "Laptop", path: "~" },
      }),
    ).rejects.toThrow(
      /No device named "Laptop".*Connected devices: Studio Mac/,
    );
  },
);

serverTest(
  "the workspace CLI cannot pose as a computer",
  async ({ server }) => {
    const serve = vi.fn();
    const attempt = await server.rpc.devices
      .serve({
        device: {
          id: "cli",
          name: "Fake",
          platform: "linux",
          home: "/",
        },
      })
      .then(serve)
      .catch((error: Error) => error);
    expect(serve).not.toHaveBeenCalled();
    expect(String(attempt)).toMatch(/Only the Halo desktop app/);
    expect(await listDevices(server)).toEqual([]);
  },
);
