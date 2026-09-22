import fs from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import {
  type ControlPlaneClient,
  type ControlPlaneSession,
} from "@get-halo/shared/controlPlaneContract";
import { SerialQueue } from "@get-halo/shared/SerialQueue";
import { safeStorage } from "electron";
import * as errore from "errore";
import type { HaloRpcConnection } from "../../shared/HaloRpcConnection.js";
import type { DesktopAuthentication } from "../DesktopAuthentication.js";
import { openExternalUrl } from "../openExternalUrl.js";

const loopbackHost = "127.0.0.1";
const callbackPath = "/auth/callback";
const callbackTimeoutMs = 5 * 60 * 1_000;

class ControlPlaneAuthError extends errore.createTaggedError({
  name: "ControlPlaneAuthError",
  message: "Halo authentication failed while trying to $operation",
}) {}

type ListeningDesktopAuthCallback = {
  callbackUrl: string;
  code: Promise<string | ControlPlaneAuthError>;
  close: () => Promise<undefined | ControlPlaneAuthError>;
};

export class ControlPlaneAuth implements DesktopAuthentication {
  // Serializes session-token changes across windows.
  private readonly actionQueue = new SerialQueue();

  private readonly createSession:
    | (() => Promise<{ token: string } | Error>)
    | undefined;
  private readonly origin: string;
  private readonly sessionStore: ControlPlaneSessionStore | undefined;
  // Preserves a startup storage failure until the renderer can present it.
  private restoreError: Error | undefined;
  // Holds the bearer token in the main process after secure storage is loaded.
  private token: string | undefined;

  private constructor(ctx: {
    createSession: (() => Promise<{ token: string } | Error>) | undefined;
    origin: string;
    restoreError: Error | undefined;
    sessionStore: ControlPlaneSessionStore | undefined;
    token: string | undefined;
  }) {
    this.createSession = ctx.createSession;
    this.origin = ctx.origin;
    this.restoreError = ctx.restoreError;
    this.sessionStore = ctx.sessionStore;
    this.token = ctx.token;
  }

  static async start(
    ctx:
      | { origin: string; dataDir: string }
      | {
          origin: string;
          createSession: () => Promise<{ token: string } | Error>;
        },
  ) {
    if ("createSession" in ctx) {
      return new ControlPlaneAuth({
        createSession: ctx.createSession,
        origin: ctx.origin,
        restoreError: undefined,
        sessionStore: undefined,
        token: undefined,
      });
    }

    const sessionStore = new ControlPlaneSessionStore({
      path: join(ctx.dataDir, "control-plane-session"),
    });
    const token = await sessionStore.read();

    return new ControlPlaneAuth({
      createSession: undefined,
      origin: ctx.origin,
      restoreError: token instanceof Error ? token : undefined,
      sessionStore,
      token: token instanceof Error ? undefined : token,
    });
  }

  async getSession() {
    return await this.actionQueue.run(
      async () => await this.getSessionUnqueued(),
    );
  }

  async signIn() {
    return await this.actionQueue.run(async () => await this.signInUnqueued());
  }

  async getWorkspaceConnection() {
    return await this.actionQueue.run(async () => {
      if (this.token === undefined) return undefined;

      const connection = {
        origin: this.origin,
        path: "/workspace/rpc",
        token: this.token,
        extensionPath: "/workspace/extensions",
      } satisfies HaloRpcConnection;

      const health = await fetch(`${this.origin}/workspace/health`, {
        headers: { authorization: `Bearer ${this.token}` },
      }).catch(
        (cause) =>
          new ControlPlaneAuthError({
            operation: "connect to your workspace",
            cause,
          }),
      );
      if (health instanceof Error) return health;
      if (health.status === 502 || health.status === 503) return undefined;
      if (!health.ok) {
        return new ControlPlaneAuthError({
          operation: "connect to your workspace",
        });
      }

      return connection;
    });
  }

  private async getSessionUnqueued() {
    if (this.restoreError !== undefined) {
      const error = this.restoreError;
      this.restoreError = undefined;
      return error;
    }

    if (this.token === undefined) {
      const created = await this.createSessionUnqueued();
      if (created instanceof Error) return created;
    }

    const token = this.token;
    if (token === undefined) return undefined;
    return await this.readSignedInSession(token, true);
  }

  private async signInUnqueued() {
    if (this.createSession !== undefined) {
      const session = await this.getSessionUnqueued();
      if (session instanceof Error) return session;
      if (session === undefined) {
        return new ControlPlaneAuthError({
          operation: "sign in with Application Default Credentials",
        });
      }
      return session;
    }

    const client = this.createClient();

    const state = randomBytes(32).toString("base64url");
    const callback = await listenForDesktopAuthCallback(state);
    if (callback instanceof Error) return callback;

    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await callback.close();
      if (closed instanceof Error) console.error(closed);
    });

    const started = await client.auth
      .start({ callback: callback.callbackUrl, state })
      .catch(
        (cause) =>
          new ControlPlaneAuthError({
            operation: "start Google sign-in",
            cause,
          }),
      );
    if (started instanceof Error) return started;

    const opened = await openExternalUrl(started.authorizationUrl);
    if (opened instanceof Error) {
      return new ControlPlaneAuthError({
        operation: "open Google sign-in",
        cause: opened,
      });
    }

    const code = await callback.code;
    if (code instanceof Error) return code;

    const exchanged = await client.auth.exchange({ code }).catch(
      (cause) =>
        new ControlPlaneAuthError({
          operation: "finish Google sign-in",
          cause,
        }),
    );
    if (exchanged instanceof Error) return exchanged;

    const workspace = await this.createClient(exchanged.token)
      .workspace.ensure()
      .catch(
        (cause) =>
          new ControlPlaneAuthError({
            operation: "prepare your workspace",
            cause,
          }),
      );
    if (workspace instanceof Error) return workspace;

    const saved = await this.writeStoredSession(exchanged.token);
    if (saved instanceof Error) return saved;

    this.token = exchanged.token;
    this.restoreError = undefined;

    const { token: _token, ...session } = exchanged;
    return session;
  }

  private async createSessionUnqueued() {
    if (this.createSession === undefined) return undefined;

    const created = await this.createSession();
    if (created instanceof Error) return created;

    this.token = created.token;
    this.restoreError = undefined;
    return created;
  }

  private async readSignedInSession(
    token: string,
    allowCreate: boolean,
  ): Promise<ControlPlaneSession | Error | undefined> {
    const client = this.createClient(token);
    const authentication = await client.auth.session().catch(
      (cause) =>
        new ControlPlaneAuthError({
          operation: "restore the session",
          cause,
        }),
    );
    if (authentication instanceof Error) return authentication;
    if (authentication.status === "signed-in") {
      const workspace = await client.workspace.ensure().catch(
        (cause) =>
          new ControlPlaneAuthError({
            operation: "prepare your workspace",
            cause,
          }),
      );
      if (workspace instanceof Error) return workspace;

      return authentication.session;
    }

    const removed = await this.removeStoredSession();
    if (removed instanceof Error) return removed;

    this.token = undefined;
    if (!allowCreate || this.createSession === undefined) return undefined;

    const created = await this.createSessionUnqueued();
    if (created instanceof Error) return created;
    const refreshed = this.token;
    if (refreshed === undefined) return undefined;

    return await this.readSignedInSession(refreshed, false);
  }

  private async writeStoredSession(token: string) {
    if (this.sessionStore === undefined) return;
    return await this.sessionStore.write(token);
  }

  private async removeStoredSession() {
    if (this.sessionStore === undefined) return;
    return await this.sessionStore.remove();
  }

  private createClient(token?: string) {
    return createControlPlaneClient(this.origin, token);
  }
}

class ControlPlaneSessionStore {
  private readonly path: string;

  constructor(ctx: { path: string }) {
    this.path = ctx.path;
  }

  async read() {
    const encrypted = await fs
      .readFile(this.path)
      .catch((cause: NodeJS.ErrnoException) =>
        cause.code === "ENOENT"
          ? undefined
          : new ControlPlaneAuthError({
              operation: "read the saved session",
              cause,
            }),
      );
    if (encrypted === undefined || encrypted instanceof Error) return encrypted;

    const available = await safeStorage.isAsyncEncryptionAvailable().catch(
      (cause) =>
        new ControlPlaneAuthError({
          operation: "access secure session storage",
          cause,
        }),
    );
    if (available instanceof Error) return available;

    if (!available) {
      return new ControlPlaneAuthError({
        operation: "access secure session storage",
      });
    }

    const decrypted = await safeStorage.decryptStringAsync(encrypted).catch(
      (cause) =>
        new ControlPlaneAuthError({
          operation: "decrypt the saved session",
          cause,
        }),
    );
    if (decrypted instanceof Error) return decrypted;

    if (decrypted.shouldReEncrypt) {
      const saved = await this.write(decrypted.result);
      if (saved instanceof Error) return saved;
    }

    return decrypted.result;
  }

  async write(token: string) {
    const available = await safeStorage.isAsyncEncryptionAvailable().catch(
      (cause) =>
        new ControlPlaneAuthError({
          operation: "access secure session storage",
          cause,
        }),
    );
    if (available instanceof Error) return available;

    if (!available) {
      return new ControlPlaneAuthError({
        operation: "access secure session storage",
      });
    }

    const encrypted = await safeStorage.encryptStringAsync(token).catch(
      (cause) =>
        new ControlPlaneAuthError({
          operation: "encrypt the session",
          cause,
        }),
    );
    if (encrypted instanceof Error) return encrypted;

    return await fs
      .writeFile(this.path, encrypted, { mode: 0o600 })
      .catch(
        (cause) =>
          new ControlPlaneAuthError({ operation: "save the session", cause }),
      );
  }

  async remove() {
    return await fs.rm(this.path, { force: true }).catch(
      (cause) =>
        new ControlPlaneAuthError({
          operation: "remove the expired session",
          cause,
        }),
    );
  }
}

function createControlPlaneClient(origin: string, token?: string) {
  const link = new RPCLink({
    origin,
    url: "/rpc",
    headers:
      token === undefined ? undefined : { authorization: `Bearer ${token}` },
  });

  // SAFETY: The configured origin serves controlPlaneContract at /rpc.
  return createORPCClient(link) as ControlPlaneClient;
}

async function listenForDesktopAuthCallback(state: string) {
  return await new Promise<
    ListeningDesktopAuthCallback | ControlPlaneAuthError
  >((resolve) => {
    let resolveCode!: (result: string | ControlPlaneAuthError) => void;
    const code = new Promise<string | ControlPlaneAuthError>(
      (resolveResult) => {
        resolveCode = resolveResult;
      },
    );
    let timeout: NodeJS.Timeout | undefined;

    const server = createServer((request, response) => {
      receiveDesktopAuthCallback({ request, response, state, resolveCode });
    });
    const listenError = (cause: Error) => {
      resolve(
        new ControlPlaneAuthError({
          operation: "listen for Google sign-in",
          cause,
        }),
      );
    };

    server.once("error", listenError);
    server.listen(0, loopbackHost, () => {
      server.off("error", listenError);
      server.once("error", (cause) => {
        resolveCode(
          new ControlPlaneAuthError({
            operation: "receive Google sign-in",
            cause,
          }),
        );
      });

      // SAFETY: Node returns a TCP address after successfully listening with a numeric port.
      const address = server.address() as AddressInfo;
      timeout = setTimeout(() => {
        resolveCode(
          new ControlPlaneAuthError({
            operation: "wait for Google sign-in",
          }),
        );
      }, callbackTimeoutMs);

      resolve({
        callbackUrl: `http://${loopbackHost}:${address.port}${callbackPath}`,
        code,
        close: async () => {
          if (timeout !== undefined) clearTimeout(timeout);
          return await closeCallbackServer(server);
        },
      });
    });
  });
}

function receiveDesktopAuthCallback(ctx: {
  request: IncomingMessage;
  response: ServerResponse;
  state: string;
  resolveCode: (result: string | ControlPlaneAuthError) => void;
}) {
  const url = new URL(
    ctx.request.url === undefined ? "/" : ctx.request.url,
    "http://localhost",
  );
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");

  if (
    ctx.request.method !== "GET" ||
    url.pathname !== callbackPath ||
    code === null ||
    state !== ctx.state
  ) {
    ctx.response.writeHead(400).end("Halo could not finish signing in.");
    return;
  }

  ctx.response
    .writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; charset=utf-8",
    })
    .end("Sign-in complete. You can return to Halo.");
  ctx.resolveCode(code);
}

async function closeCallbackServer(server: HttpServer) {
  const closing = new Promise<undefined | ControlPlaneAuthError>((resolve) => {
    server.close((cause) => {
      resolve(
        cause === undefined
          ? undefined
          : new ControlPlaneAuthError({
              operation: "close the sign-in callback",
              cause,
            }),
      );
    });
  });

  server.closeAllConnections();
  return await closing;
}
