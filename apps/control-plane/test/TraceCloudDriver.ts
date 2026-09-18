import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { buffer } from "node:stream/consumers";
import {
  GoogleAuth,
  OAuth2Client,
  type TokenPayload,
} from "google-auth-library";
import { TraceCloud } from "../src/traces/TraceCloud.js";

export class TraceCloudDriver {
  // Simulates current Compute Engine instances and immutable GCS objects.
  readonly instances = new Map<string, string>();
  readonly objects = new Map<string, Buffer>();
  // Records storage requests, including retries and rejected preconditions.
  readonly uploads: Array<{
    key: string;
    authorization: string | undefined;
    precondition: string | null;
  }> = [];
  // Injects an external storage failure for the next upload attempt.
  nextUploadStatus = 200;
  private readonly server: http.Server;
  private readonly keys: { privateKey: string; publicKey: string };

  private constructor() {
    this.keys = crypto.generateKeyPairSync("rsa", {
      modulusLength: 2048,
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    this.server = http.createServer(async (request, response) => {
      const url = new URL(request.url!, "http://localhost");
      if (url.pathname === "/certs") {
        response
          .writeHead(200, {
            "content-type": "application/json",
            "cache-control": "max-age=3600",
          })
          .end(JSON.stringify({ test: this.keys.publicKey }));
        return;
      }
      if (
        url.pathname.startsWith(
          "/compute/v1/projects/trace-project/zones/us-west2-a/instances/halo-",
        )
      ) {
        const workspaceId = url.pathname.slice(
          url.pathname.lastIndexOf("/halo-") + 6,
        );
        const id = this.instances.get(workspaceId);
        response
          .writeHead(id === undefined ? 404 : 200, {
            "content-type": "application/json",
          })
          .end(JSON.stringify({ id }));
        return;
      }
      if (url.pathname === "/upload/storage/v1/b/test-traces/o") {
        const key = url.searchParams.get("name")!;
        this.uploads.push({
          key,
          authorization: request.headers.authorization,
          precondition: url.searchParams.get("ifGenerationMatch"),
        });
        const bytes = await buffer(request);
        const status = this.nextUploadStatus;
        this.nextUploadStatus = 200;
        if (status !== 200) {
          response.writeHead(status).end("Storage unavailable");
          return;
        }
        if (this.objects.has(key)) {
          response.writeHead(412).end("Already exists");
          return;
        }
        this.objects.set(key, bytes);
        response
          .writeHead(200, { "content-type": "application/json" })
          .end("{}");
        return;
      }
      response.writeHead(404).end();
    });
  }

  static async start() {
    const driver = new TraceCloudDriver();
    driver.server.listen(0, "127.0.0.1");
    await once(driver.server, "listening");
    return driver;
  }

  cloud() {
    // SAFETY: start() waits for the TCP listener before callers construct clients.
    const address = this.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    const credentials = new OAuth2Client();
    credentials.setCredentials({
      access_token: "control-plane-storage-token",
      expiry_date: Date.now() + 3_600_000,
    });
    return new TraceCloud({
      bucket: "test-traces",
      projectId: "trace-project",
      zone: "us-west2-a",
      serviceAccount: "workspaces@trace-project.iam.gserviceaccount.com",
      auth: new GoogleAuth({ authClient: credentials }),
      verifier: new OAuth2Client({
        endpoints: { oauth2FederatedSignonPemCertsUrl: `${origin}/certs` },
      }),
      storageOrigin: origin,
      computeOrigin: origin,
    });
  }

  token(input: {
    origin: string;
    workspaceId: string;
    claims?: Partial<TokenPayload> & {
      google?: {
        compute_engine: {
          project_id: string;
          zone: string;
          instance_id: string;
          instance_name: string;
        };
      };
    };
  }) {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: "RS256", kid: "test" }),
    ).toString("base64url");
    const payload = Buffer.from(
      JSON.stringify({
        iss: "https://accounts.google.com",
        aud: new URL("/api/traces", input.origin).toString(),
        sub: "shared-service-account-id",
        email: "workspaces@trace-project.iam.gserviceaccount.com",
        email_verified: true,
        iat: now,
        exp: now + 3600,
        google: {
          compute_engine: {
            project_id: "trace-project",
            zone: "us-west2-a",
            instance_id: this.instances.get(input.workspaceId),
            instance_name: `halo-${input.workspaceId}`,
          },
        },
        ...input.claims,
      }),
    ).toString("base64url");
    const message = `${header}.${payload}`;
    return `${message}.${crypto.sign("RSA-SHA256", Buffer.from(message), this.keys.privateKey).toString("base64url")}`;
  }

  async close() {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      this.server.close((error) => {
        if (error !== undefined) return reject(error);
        resolve();
      }),
    );
  }
}
