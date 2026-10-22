import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

export const deviceSettingsSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1, maxLength: 64 }),
  /** Whether this computer connects to the workspace at all. */
  enabled: Type.Boolean(),
  files: Type.Object({
    /** Folders the person allowed when the agent first asked. */
    grants: Type.Array(
      Type.Object({
        path: Type.String({ minLength: 1 }),
        access: Type.Union([Type.Literal("read"), Type.Literal("write")]),
      }),
    ),
  }),
  /** Whether the person allowed the agent to run commands. */
  commands: Type.Optional(Type.Object({ allowed: Type.Boolean() })),
});

export type DeviceSettings = Static<typeof deviceSettingsSchema>;
export type DeviceSettingsUpdate = Partial<
  Pick<DeviceSettings, "name" | "enabled" | "files" | "commands">
>;

export class DeviceSettingsError extends errore.createTaggedError({
  name: "DeviceSettingsError",
  message: "Could not $operation device settings at $path",
}) {}

/** Saves this computer's device settings as one JSON file in app data. */
export class DeviceSettingsStore {
  private readonly path: string;
  private current: DeviceSettings | undefined;

  constructor(ctx: { dataDir: string }) {
    this.path = path.join(ctx.dataDir, "device.json");
  }

  async read(): Promise<DeviceSettings | DeviceSettingsError> {
    if (this.current !== undefined) return this.current;
    const text = await fs
      .readFile(this.path, "utf8")
      .catch((cause: unknown) =>
        cause instanceof Error ? cause : new Error(String(cause)),
      );
    if (text instanceof Error && !isMissing(text))
      return new DeviceSettingsError({
        operation: "read",
        path: this.path,
        cause: text,
      });
    const parsed = text instanceof Error ? undefined : parseSettings(text);
    if (parsed !== undefined) {
      this.current = parsed;
      return parsed;
    }
    // The computer this app runs on is available at once. Nothing is
    // shared until the person answers an access prompt.
    const created: DeviceSettings = {
      id: crypto.randomUUID(),
      name: defaultDeviceName(),
      enabled: true,
      files: { grants: [] },
    };
    const saved = await this.write(created);
    if (saved instanceof Error) return saved;
    return created;
  }

  async update(
    update: DeviceSettingsUpdate,
  ): Promise<DeviceSettings | DeviceSettingsError> {
    const current = await this.read();
    if (current instanceof Error) return current;
    const next: DeviceSettings = {
      ...current,
      ...update,
      files: update.files ?? current.files,
    };
    if (!Value.Check(deviceSettingsSchema, next))
      return new DeviceSettingsError({
        operation: "validate",
        path: this.path,
      });
    const saved = await this.write(next);
    if (saved instanceof Error) return saved;
    return next;
  }

  private async write(settings: DeviceSettings) {
    const created = await fs
      .mkdir(path.dirname(this.path), { recursive: true })
      .catch(
        (cause) =>
          new DeviceSettingsError({
            operation: "save",
            path: this.path,
            cause,
          }),
      );
    if (created instanceof Error) return created;
    const written = await fs
      .writeFile(this.path, `${JSON.stringify(settings, undefined, 2)}\n`, {
        mode: 0o600,
      })
      .catch(
        (cause) =>
          new DeviceSettingsError({
            operation: "save",
            path: this.path,
            cause,
          }),
      );
    if (written instanceof Error) return written;
    this.current = settings;
  }
}

function parseSettings(text: string): DeviceSettings | undefined {
  // An unreadable file starts a new identity, like a fresh install.
  const value = errore.try({
    try: () => JSON.parse(text),
    catch: () => undefined,
  });
  return Value.Check(deviceSettingsSchema, value) ? value : undefined;
}

function defaultDeviceName() {
  const host = os.hostname().replace(/\.local$/, "");
  return (host || "My computer").slice(0, 64);
}

function isMissing(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
