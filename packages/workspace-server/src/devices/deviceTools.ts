import crypto from "node:crypto";
import path from "node:path";
import { Type, type Static, type TObject } from "@sinclair/typebox";
import {
  deviceFileLimits,
  deviceShellLimits,
  type DeviceSummary,
} from "@get-halo/client";
import * as errore from "errore";
import { haloTool, type HaloToolContext } from "../agent/tools/HaloTool.js";
import { readFile, type TextFiles } from "../agent/tools/files/read.js";
import { editFile } from "../agent/tools/files/edit.js";
import { writeFile } from "../agent/tools/files/write.js";
import { deviceFailure, type DeviceService } from "./DeviceService.js";

export class DeviceFileTooLargeError extends errore.createTaggedError({
  name: "DeviceFileTooLargeError",
  message: "$path is $size bytes; device file transfers are limited to $limit",
}) {}

const device = Type.String({
  minLength: 1,
  description: "Device name or ID from tools.devices.list()",
});
const devicePath = Type.String({
  minLength: 1,
  description:
    "Absolute path, ~/ path, or a path relative to the device's home folder",
});

type DeviceToolContext = {
  devices: DeviceService;
  device: DeviceSummary;
  context: HaloToolContext;
  resolvePath: (value: string) => string;
};

function deviceTool<S extends TObject>(definition: {
  description: string;
  inputSchema: S;
  requiredCapabilities: readonly string[];
  execute: (
    input: Static<S>,
    tool: DeviceToolContext,
  ) => Promise<object | Error>;
}) {
  return haloTool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    requiredCapabilities: definition.requiredCapabilities,
    execute: async (input, context) => {
      const devices = context.services.devices;
      // SAFETY: Every device tool schema starts with the device property.
      const name = (input as Static<S> & { device: string }).device;
      const summary = devices.resolve(name);
      if (summary instanceof Error) return summary;
      const result = await definition.execute(input, {
        devices,
        device: summary,
        context,
        resolvePath: (value) => resolveDevicePath(summary, value),
      });
      // Shared file helpers wrap errors; the agent needs the device's reason.
      if (result instanceof Error) return deviceFailure(result);
      return { result: { device: summary.name, ...result } };
    },
  });
}

/** Device paths are POSIX; macOS is the supported desktop platform. */
function resolveDevicePath(summary: DeviceSummary, value: string) {
  if (value === "~") return summary.home;
  if (value.startsWith("~/"))
    return path.posix.join(summary.home, value.slice(2));
  return path.posix.resolve(summary.home, value);
}

function deviceTextFiles(tool: DeviceToolContext): TextFiles {
  return {
    readFile: async (filePath) => {
      const read = await tool.devices.call({
        device: tool.device.id,
        operation: {
          type: "files.read",
          path: filePath,
          encoding: "utf8",
          maxBytes: deviceFileLimits.maxBytes,
        },
        signal: tool.context.signal,
      });
      if (read instanceof Error) return read;
      return read.data;
    },
    writeFile: async (filePath, data) => {
      const written = await tool.devices.call({
        device: tool.device.id,
        operation: {
          type: "files.write",
          path: filePath,
          data,
          encoding: "utf8",
        },
        signal: tool.context.signal,
      });
      if (written instanceof Error) return written;
    },
  };
}

export const deviceTools = {
  list: haloTool({
    description:
      "List the person's own computers running Halo, with online status, platform, and home folder. Pass a device's name to the other tools.devices tools. The first time the agent uses a folder on a computer, the person is asked there to allow read or read-and-write access; a refusal returns access_denied. Workspace tools such as files and bash run on the workspace VM, never on a device.",
    inputSchema: Type.Object({}),
    requiredCapabilities: ["devices.list"],
    execute: async (_, context) => ({
      result: { devices: context.services.devices.list() },
    }),
  }),
  files: {
    list: deviceTool({
      description:
        "List a folder on one of the person's computers. The person may be asked to allow access first.",
      inputSchema: Type.Object({ device, path: devicePath }),
      requiredCapabilities: ["devices.files.read"],
      execute: async (input, tool) =>
        await tool.devices.call({
          device: tool.device.id,
          operation: { type: "files.list", path: tool.resolvePath(input.path) },
          signal: tool.context.signal,
        }),
    }),
    read: deviceTool({
      description:
        "Read a UTF-8 text file on one of the person's computers. Use offset and limit (1-based lines) for narrow reads. For images, PDFs and other binary files, use copyToWorkspace and then workspace tools such as viewImage.",
      inputSchema: Type.Object({
        device,
        path: devicePath,
        offset: Type.Optional(Type.Number()),
        limit: Type.Optional(Type.Number()),
      }),
      requiredCapabilities: ["devices.files.read"],
      execute: async (input, tool) =>
        await readFile({
          filesystem: deviceTextFiles(tool),
          cwd: tool.device.home,
          input: { ...input, path: tool.resolvePath(input.path) },
        }),
    }),
    write: deviceTool({
      description:
        "Create or replace a UTF-8 text file on one of the person's computers. The person may be asked to allow changes to that folder first.",
      inputSchema: Type.Object({
        device,
        path: devicePath,
        content: Type.String(),
      }),
      requiredCapabilities: ["devices.files.write"],
      execute: async (input, tool) =>
        await writeFile({
          filesystem: deviceTextFiles(tool),
          cwd: tool.device.home,
          input: { path: tool.resolvePath(input.path), content: input.content },
        }),
    }),
    edit: deviceTool({
      description:
        "Replace exact text in a UTF-8 file on one of the person's computers. The person may be asked to allow changes to that folder first.",
      inputSchema: Type.Object({
        device,
        path: devicePath,
        oldText: Type.String(),
        newText: Type.String(),
        replaceAll: Type.Optional(Type.Boolean()),
      }),
      requiredCapabilities: ["devices.files.write"],
      execute: async (input, tool) =>
        await editFile({
          filesystem: deviceTextFiles(tool),
          cwd: tool.device.home,
          input: { ...input, path: tool.resolvePath(input.path) },
        }),
    }),
    delete: deviceTool({
      description:
        "Delete a file on one of the person's computers. Folders are refused. The person may be asked to allow changes to that folder first.",
      inputSchema: Type.Object({ device, path: devicePath }),
      requiredCapabilities: ["devices.files.write"],
      execute: async (input, tool) =>
        await tool.devices.call({
          device: tool.device.id,
          operation: {
            type: "files.delete",
            path: tool.resolvePath(input.path),
          },
          signal: tool.context.signal,
        }),
    }),
    copyToWorkspace: deviceTool({
      description: `Copy a file from one of the person's computers into the workspace, for binary files or other workspace tools. Returns workspacePath; for an image, then call viewImage({ path: workspacePath }). Files are limited to ${deviceFileLimits.maxBytes / 1024 / 1024} MiB.`,
      inputSchema: Type.Object({
        device,
        path: devicePath,
        workspacePath: Type.Optional(
          Type.String({
            minLength: 1,
            description:
              "Workspace-relative destination. Defaults to a new folder under .halo/device-files/.",
          }),
        ),
      }),
      requiredCapabilities: ["devices.files.read", "workspace.files.write"],
      execute: async (input, tool) => {
        const source = tool.resolvePath(input.path);
        const read = await tool.devices.call({
          device: tool.device.id,
          operation: {
            type: "files.read",
            path: source,
            encoding: "base64",
            maxBytes: deviceFileLimits.maxBytes,
          },
          signal: tool.context.signal,
        });
        if (read instanceof Error) return read;
        const workspacePath =
          input.workspacePath ??
          path.join(
            ".halo/device-files",
            crypto.randomUUID(),
            path.posix.basename(source),
          );
        const destination = path.resolve(
          tool.context.workspaceRoot,
          workspacePath,
        );
        const filesystem = tool.context.services.filesystem;
        const created = await filesystem.makeDirectory(
          path.dirname(destination),
          { recursive: true },
        );
        if (created instanceof Error) return created;
        const written = await filesystem.writeFile(
          destination,
          Buffer.from(read.data, "base64"),
        );
        if (written instanceof Error) return written;
        return { path: source, workspacePath, size: read.size };
      },
    }),
    copyFromWorkspace: deviceTool({
      description: `Copy a workspace file to one of the person's computers, replacing any file at that path. The person may be asked to allow changes to that folder first. Files are limited to ${deviceFileLimits.maxBytes / 1024 / 1024} MiB.`,
      inputSchema: Type.Object({
        device,
        workspacePath: Type.String({ minLength: 1 }),
        path: devicePath,
      }),
      requiredCapabilities: ["workspace.files.read", "devices.files.write"],
      execute: async (input, tool) => {
        const filesystem = tool.context.services.filesystem;
        const source = path.resolve(
          tool.context.workspaceRoot,
          input.workspacePath,
        );
        const stat = await filesystem.stat(source);
        if (stat instanceof Error) return stat;
        if (stat.size > deviceFileLimits.maxBytes)
          return new DeviceFileTooLargeError({
            path: input.workspacePath,
            size: String(stat.size),
            limit: String(deviceFileLimits.maxBytes),
          });
        const bytes = await filesystem.readFile(source);
        if (bytes instanceof Error) return bytes;
        return await tool.devices.call({
          device: tool.device.id,
          operation: {
            type: "files.write",
            path: tool.resolvePath(input.path),
            data: bytes.toString("base64"),
            encoding: "base64",
          },
          signal: tool.context.signal,
        });
      },
    }),
  },
  shell: {
    run: deviceTool({
      description: `Run a command in the login shell on one of the person's computers, as that person, starting in their home folder unless cwd is given. Use it only for work on their computer; use tools.bash.run for the workspace. The first time, the person is asked on that computer to allow commands; a refusal returns access_denied. Returns code, stdout, stderr, timedOut and truncated. Timeout defaults to ${deviceShellLimits.defaultTimeoutMs / 1000} seconds, maximum ${deviceShellLimits.maxTimeoutMs / 60_000} minutes. Long output keeps its beginning and end.`,
      inputSchema: Type.Object({
        device,
        command: Type.String({ minLength: 1 }),
        cwd: Type.Optional(devicePath),
        timeoutMs: Type.Optional(
          Type.Integer({
            minimum: 1,
            maximum: deviceShellLimits.maxTimeoutMs,
          }),
        ),
      }),
      requiredCapabilities: ["devices.shell.execute"],
      execute: async (input, tool) => {
        const timeoutMs = input.timeoutMs ?? deviceShellLimits.defaultTimeoutMs;
        return await tool.devices.call({
          device: tool.device.id,
          operation: {
            type: "shell.run",
            command: input.command,
            cwd:
              input.cwd === undefined ? undefined : tool.resolvePath(input.cwd),
            timeoutMs,
          },
          signal: tool.context.signal,
          // Leave time for the person to answer the first-use prompt.
          timeoutMs: timeoutMs + 5 * 60_000,
        });
      },
    }),
  },
};
