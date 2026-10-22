import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { ToolApproval } from "./sessionState.js";

/** What the person allowed the workspace agent to do in one folder. */
export type DeviceFileAccess = "read" | "write";

/** What a connected device tells its workspace about itself. */
export type DeviceAdvertisement = {
  /** Stable for one Halo install; generated on first use. */
  id: string;
  name: string;
  platform: string;
  /** Absolute home folder, used to resolve `~/` and relative paths. */
  home: string;
};

export type DeviceSummary = DeviceAdvertisement & {
  online: boolean;
  lastSeenAt: number;
};

export type DeviceFileEntry = {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: number;
};

export type DeviceFileEncoding = "utf8" | "base64";

/** A file operation the workspace asks a device to run. Paths are absolute. */
export type DeviceFileOperation =
  | { type: "files.list"; path: string }
  | { type: "files.stat"; path: string }
  | {
      type: "files.read";
      path: string;
      encoding: DeviceFileEncoding;
      maxBytes: number;
    }
  | {
      type: "files.write";
      path: string;
      data: string;
      encoding: DeviceFileEncoding;
    }
  | { type: "files.delete"; path: string };

/** One operation the workspace asks a device to run. */
export type DeviceOperation =
  | DeviceFileOperation
  | {
      type: "shell.run";
      command: string;
      /** Absolute working folder; defaults to the device's home folder. */
      cwd?: string;
      timeoutMs: number;
    };

export type DeviceShellResult = {
  /** Exit code; undefined when a signal or timeout ended the command. */
  code?: number;
  signal?: string;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** True when the middle of long output was omitted. */
  truncated: boolean;
};

export type DeviceOperationResult = {
  "files.list": { path: string; entries: DeviceFileEntry[] };
  "files.stat": DeviceFileEntry;
  "files.read": { path: string; data: string; size: number };
  "files.write": { path: string; size: number };
  "files.delete": { path: string };
  "shell.run": DeviceShellResult;
};

/** Run an operation, or stop one the agent cancelled. */
export type DeviceRequest =
  | { callId: string; operation: DeviceOperation }
  | { cancel: string };

export type DeviceOperationOutput =
  DeviceOperationResult[keyof DeviceOperationResult];

/** What a device needs the person to allow before it runs an operation. */
export type DevicePermissionRequest =
  | {
      kind: "folder";
      /** The folder a grant would cover, with its subfolders. */
      folder: string;
      access: DeviceFileAccess;
      /** The path the agent asked for. */
      path: string;
    }
  | { kind: "commands"; command: string; cwd: string };

export type DeviceResponse =
  | {
      deviceId: string;
      callId: string;
      ok: true;
      result: DeviceOperationOutput;
    }
  | {
      deviceId: string;
      callId: string;
      ok: false;
      error: {
        code: string;
        message: string;
        /** Present when the person must allow access in Halo first. */
        permission?: DevicePermissionRequest;
      };
    };

/** Approval arguments that mark a device permission card in a thread. */
export const devicePermissionSchema = Type.Object({
  deviceId: Type.String(),
  deviceName: Type.String(),
  /** Lets cards show paths under home as ~/… */
  deviceHome: Type.String(),
  request: Type.Union([
    Type.Object({
      kind: Type.Literal("folder"),
      folder: Type.String(),
      access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      path: Type.String(),
    }),
    Type.Object({
      kind: Type.Literal("commands"),
      command: Type.String(),
      cwd: Type.String(),
    }),
  ]),
});

export type DevicePermission = Static<typeof devicePermissionSchema>;

/** Reads the device permission an approval card asks for, if it is one. */
export function devicePermissionOf(
  approval: ToolApproval,
): DevicePermission | undefined {
  const args = approval.arguments;
  return Value.Check(
    Type.Object({ devicePermission: devicePermissionSchema }),
    args,
  )
    ? args.devicePermission
    : undefined;
}

export const deviceShellLimits = {
  defaultTimeoutMs: 60_000,
  maxTimeoutMs: 10 * 60_000,
  /** Characters kept from the start and end of each output stream. */
  headChars: 8_000,
  tailChars: 24_000,
} as const;

export const deviceFileLimits = {
  /** Keeps one response under the socket and gateway body limits. */
  maxBytes: 8 * 1024 * 1024,
} as const;
