import childProcess from "node:child_process";
import * as errore from "errore";

export class ExeApiError extends errore.createTaggedError({
  name: "ExeApiError",
  message: "Exe API failed: $detail",
}) {
  status?: number;
}

/** Exe's documented HTTPS command API and VM-scoped SSH signatures. */
export class ExeApi {
  // Short-lived credentials are reusable until shortly before their expiry.
  private readonly tokens = new Map<
    string,
    { value: string; expiresAt: number }
  >();
  private readonly privateKeyPath: string;
  constructor(ctx: { privateKeyPath: string }) {
    this.privateKeyPath = ctx.privateKeyPath;
  }

  async execute(args: readonly string[]) {
    const token = await this.token("v0@exe.dev");
    if (token instanceof Error) return token;
    const response = await fetch("https://exe.dev/exec", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "text/plain",
      },
      body: args.map(quote).join(" "),
      // Exe's /exec endpoint has a documented 30-second execution limit.
      signal: AbortSignal.timeout(35_000),
    }).catch((cause) => new ExeApiError({ detail: "send command", cause }));
    if (response instanceof Error) return response;
    if (!response.ok) {
      const error = new ExeApiError({ detail: `HTTP ${response.status}` });
      error.status = response.status;
      return error;
    }
    return await response
      .text()
      .catch((cause) => new ExeApiError({ detail: "read response", cause }));
  }

  async vmAuthorization(vmName: string) {
    const token = await this.token(`v0@${vmName}.exe.xyz`);
    if (token instanceof Error) return token;
    return `Bearer ${token}`;
  }

  private async token(namespace: string) {
    const cached = this.tokens.get(namespace);
    if (cached !== undefined && cached.expiresAt > Date.now() + 60_000)
      return cached.value;
    const expiresAt = Date.now() + 15 * 60_000;
    const exp = Math.floor(expiresAt / 1000);
    const permissions =
      namespace === "v0@exe.dev"
        ? { exp, cmds: ["ls", "cp", "ssh", "pause", "resume"] }
        : { exp };
    const payload = JSON.stringify(permissions);
    const signature = await new Promise<string | ExeApiError>((resolve) => {
      const child = childProcess.execFile(
        "ssh-keygen",
        ["-Y", "sign", "-f", this.privateKeyPath, "-n", namespace],
        { encoding: "utf8", timeout: 5000 },
        (error, stdout) => {
          resolve(
            error === null
              ? stdout
              : new ExeApiError({ detail: "sign credential", cause: error }),
          );
        },
      );
      child.stdin?.end(payload);
    });
    if (signature instanceof Error) return signature;
    const signatureBytes = Buffer.from(
      signature
        .split(/\r?\n/u)
        .filter((line) => line !== "" && !line.startsWith("-----"))
        .join(""),
      "base64",
    );
    const value = `exe0.${Buffer.from(payload).toString("base64url")}.${signatureBytes.toString("base64url")}`;
    this.tokens.set(namespace, { value, expiresAt });
    return value;
  }
}

// Exe parses each POST body with a shell lexer, including remote SSH commands.
function quote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
