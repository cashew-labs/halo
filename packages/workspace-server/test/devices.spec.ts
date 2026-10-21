import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import { expect, vi } from "vitest";
import { DeviceHost, type DeviceSettings } from "@get-halo/device-host";
import type { DeviceSummary } from "@get-halo/client";
import type { TestServer } from "./TestServer.js";
import { serverTest } from "./serverTest.js";

async function connectDevice(
  server: TestServer,
  cleanup: errore.AsyncDisposableStack,
  files: DeviceSettings["files"] = { access: "write", roots: ["Documents"] },
) {
  const home = path.join(server.harness.paths.root, "device-home");
  await fs.mkdir(path.join(home, "Documents"), { recursive: true });
  await fs.writeFile(path.join(home, "Documents", "notes.md"), "Buy milk\n");
  await fs.writeFile(path.join(home, "secret.txt"), "private\n");
  const settings: DeviceSettings = {
    id: "8a0e7c63-5c2f-4f3c-9d4c-3c6a8f0f1d11",
    name: "Studio Mac",
    enabled: true,
    files: {
      ...files,
      roots: files.roots.map((root) => path.join(home, root)),
    },
  };
  const host = new DeviceHost({
    settings,
    home,
    getTransport: async () => await Promise.resolve(server.rendererTransport),
    logger: { info: () => undefined, warn: () => undefined },
  });
  host.start();
  cleanup.defer(async () => await host.stop());
  await expect
    .poll(async () => await listDevices(server))
    .toMatchObject([{ name: "Studio Mac", online: true }]);
  return { host, home, settings };
}

async function listDevices(server: TestServer) {
  const listed = await server.rpc.testApi.invokeTool({
    path: "devices.list",
    input: {},
  });
  // SAFETY: devices.list returns the summaries from DeviceService.list.
  return (listed as { devices: DeviceSummary[] }).devices;
}

serverTest(
  "the agent reads and edits files in a computer's shared folder",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const { home } = await connectDevice(server, cleanup);

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
    const { home } = await connectDevice(server, cleanup);
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
  "the computer refuses paths outside its shared folders",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    await connectDevice(server, cleanup);
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.files.read",
        input: { device: "Studio Mac", path: "~/secret.txt" },
      }),
    ).rejects.toThrow(/outside_allowed_folders/);
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.files.read",
        input: { device: "Studio Mac", path: "~/Documents/../secret.txt" },
      }),
    ).rejects.toThrow(/outside_allowed_folders/);
  },
);

serverTest(
  "new settings take effect when the computer reconnects",
  async ({ server }) => {
    await using cleanup = new errore.AsyncDisposableStack();
    const { host, home, settings } = await connectDevice(server, cleanup);
    host.update({
      ...settings,
      files: { ...settings.files, access: "read" },
    });
    await expect
      .poll(async () => await listDevices(server))
      .toMatchObject([{ online: true, files: { access: "read" } }]);
    await expect(
      server.rpc.testApi.invokeTool({
        path: "devices.files.write",
        input: {
          device: "Studio Mac",
          path: "~/Documents/notes.md",
          content: "changed",
        },
      }),
    ).rejects.toThrow(/read_only/);
    expect(
      await fs.readFile(path.join(home, "Documents/notes.md"), "utf8"),
    ).toBe("Buy milk\n");

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
  },
);

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
          files: { access: "write", roots: ["/"] },
        },
      })
      .then(serve)
      .catch((error: Error) => error);
    expect(serve).not.toHaveBeenCalled();
    expect(String(attempt)).toMatch(/Only the Halo desktop app/);
    expect(await listDevices(server)).toEqual([]);
  },
);
