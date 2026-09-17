import crypto from "node:crypto";
import path from "node:path";
import {
  type CredentialVault,
  CredentialVaultError,
} from "./CredentialVault.js";
import {
  type FilesystemService,
  FilesystemPathNotFoundError,
} from "../../filesystem/FilesystemService.js";

export class FileCredentialVault implements CredentialVault {
  private readonly filesystem: FilesystemService;
  private readonly directory: string;

  constructor(ctx: { filesystem: FilesystemService; directory: string }) {
    const { filesystem, directory } = ctx;
    this.filesystem = filesystem;
    this.directory = directory;
  }

  async get(id: string) {
    const value = await this.filesystem.readFile(this.filePath(id), "utf8");
    if (value instanceof FilesystemPathNotFoundError) return undefined;
    if (value instanceof Error) {
      return new CredentialVaultError({ operation: "read", cause: value });
    }
    return value;
  }

  async set(id: string, value: string) {
    const created = await this.filesystem.makeDirectory(this.directory, {
      recursive: true,
      mode: 0o700,
    });
    if (created instanceof Error) {
      return new CredentialVaultError({
        operation: "create directory",
        cause: created,
      });
    }

    const written = await this.filesystem.writeFile(this.filePath(id), value, {
      mode: 0o600,
    });
    if (written instanceof Error) {
      return new CredentialVaultError({ operation: "write", cause: written });
    }
  }

  async delete(id: string) {
    const removed = await this.filesystem.remove(this.filePath(id), {
      force: true,
    });
    if (removed instanceof Error) {
      return new CredentialVaultError({ operation: "delete", cause: removed });
    }
  }

  private filePath(id: string) {
    const name = crypto.createHash("sha256").update(id).digest("hex");
    return path.join(this.directory, name);
  }
}
