import http from "node:http";
import events from "node:events";
import type { AddressInfo } from "node:net";
import { text } from "node:stream/consumers";
import { createWorkspaceInference } from "../src/inference/createWorkspaceInference.js";
import type {
  CompletionRequest,
  WorkspaceInference,
} from "../src/inference/workspaceInference.js";
import { GoogleAuth, OAuth2Client } from "google-auth-library";

type ResponsePlan = {
  status: number;
  body: string;
  breakStream?: boolean;
  hold?: boolean;
};

/** Controlled HTTP provider boundary; Halo's router, auth, and streaming stay real. */
export class InferenceDriver {
  readonly requests: Array<{
    path: string;
    headers: http.IncomingHttpHeaders;
    body: CompletionRequest;
  }> = [];
  readonly primary: ResponsePlan[] = [];
  readonly fallback: ResponsePlan[] = [];
  readonly events = new events.EventEmitter();
  readonly vertexAuth = new OAuth2Client();
  private readonly server = http.createServer(async (request, response) => {
    const path = request.url ?? "";
    // SAFETY: The real inference client sends JSON objects to this fixture.
    const body = JSON.parse(await text(request)) as CompletionRequest;
    this.requests.push({ path, headers: request.headers, body });
    const plan = (path === "/primary" ? this.primary : this.fallback).shift();
    response.on("close", () => this.events.emit("closed"));
    this.events.emit("request");
    if (plan?.hold) return;
    if (plan === undefined || plan.status === 0) {
      response.destroy();
      return;
    }
    response.writeHead(plan.status, {
      "content-type":
        plan.status === 200 ? "text/event-stream" : "application/json",
      "set-cookie": "provider-secret=private",
      "x-provider-secret": "private",
    });
    if (plan.breakStream) {
      response.write(plan.body);
      setTimeout(() => response.destroy(), 20);
      return;
    }
    response.end(plan.body);
  });

  async start() {
    this.server.listen({ host: "127.0.0.1", port: 0 });
    await events.once(this.server, "listening");
  }

  configuration(): WorkspaceInference {
    // SAFETY: start() listens on a TCP port before the fixture is exposed.
    const address = this.server.address() as AddressInfo;
    const origin = `http://127.0.0.1:${address.port}`;
    this.vertexAuth.setCredentials({
      access_token: "vertex-test",
      expiry_date: Date.now() + 3_600_000,
    });
    const configuration = createWorkspaceInference({
      apiKey: "together-test",
      auth: new GoogleAuth({ authClient: this.vertexAuth }),
    });
    return {
      primary: { ...configuration.primary, url: `${origin}/primary` },
      fallback: { ...configuration.fallback, url: `${origin}/fallback` },
    };
  }

  async close() {
    this.server.closeAllConnections();
    this.server.close();
    await events.once(this.server, "close");
  }
}
