/** How much of a device's chosen folders the workspace agent may use. */
export type DeviceFileAccess = "off" | "read" | "write";

/** What a connected device tells its workspace about itself. */
export type DeviceAdvertisement = {
  /** Stable for one Halo install; generated on first use. */
  id: string;
  name: string;
  platform: string;
  /** Absolute home folder, used to resolve `~/` and relative paths. */
  home: string;
  files: { access: DeviceFileAccess; roots: string[] };
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

/** One operation the workspace asks a device to run. Paths are absolute. */
export type DeviceOperation =
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

export type DeviceOperationResult = {
  "files.list": { path: string; entries: DeviceFileEntry[] };
  "files.stat": DeviceFileEntry;
  "files.read": { path: string; data: string; size: number };
  "files.write": { path: string; size: number };
  "files.delete": { path: string };
};

export type DeviceRequest = { callId: string; operation: DeviceOperation };

export type DeviceOperationOutput =
  DeviceOperationResult[keyof DeviceOperationResult];

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
      error: { code: string; message: string };
    };

export const deviceFileLimits = {
  /** Keeps one response under the socket and gateway body limits. */
  maxBytes: 8 * 1024 * 1024,
} as const;
