import type { IncomingMessage, ServerResponse } from "node:http";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type { WorkspaceService } from "../workspace/WorkspaceService.js";
import { TraceCloud } from "./TraceCloud.js";
import { WorkspaceAuthenticationRequiredError } from "../auth/AuthService.js";

const decompress = promisify(gunzip);
const maxCompressedBytes = 16 * 1024 * 1024;
const maxExpandedBytes = 64 * 1024 * 1024;
const recordSchema = Type.Object({
  schemaVersion: Type.Literal(1),
  workspaceId: Type.String(),
  sessionId: Type.String(),
  traceId: Type.String(),
  spanId: Type.String({ pattern: "^[0-9a-f]{16}$" }),
  sequence: Type.Integer({ minimum: 0 }),
  timestamp: Type.String(),
  type: Type.String(),
});

class TraceArchiveError extends errore.createTaggedError({
  name: "TraceArchiveError",
  message: "Invalid trace archive: $detail",
}) {}

export class TraceIngestion {
  private readonly cloud: TraceCloud;
  private readonly workspace: WorkspaceService;

  constructor(ctx: { cloud: TraceCloud; workspace: WorkspaceService }) {
    const { cloud, workspace } = ctx;
    this.cloud = cloud;
    this.workspace = workspace;
  }

  async serve(request: IncomingMessage, response: ServerResponse, url: URL) {
    const headers = new Headers();
    if (request.headers.authorization !== undefined)
      headers.set("authorization", request.headers.authorization);
    const identity = await this.workspace.authenticateRuntime(headers);
    if (identity instanceof WorkspaceAuthenticationRequiredError) {
      response.writeHead(401).end();
      return;
    }
    if (identity instanceof Error) {
      console.error(identity);
      response.writeHead(503).end();
      return;
    }
    const workspaceId = identity.workspaceId;
    // The request can select a session/run, never a workspace prefix or bucket.
    const match =
      /^\/api\/traces\/([a-zA-Z0-9_-]{1,128})\/([0-9a-f]{32})$/.exec(
        url.pathname,
      );
    if (
      request.method !== "POST" ||
      match === null ||
      url.search !== "" ||
      request.headers["content-type"] !== "application/gzip"
    ) {
      response.writeHead(400).end();
      return;
    }
    const sessionId = match[1]!;
    const traceId = match[2]!;
    const body = await readArchive(request);
    if (body instanceof Error) {
      response.writeHead(400).end();
      return;
    }
    const valid = await validateArchive({
      body,
      workspaceId,
      sessionId,
      traceId,
    });
    if (valid instanceof Error) {
      response.writeHead(400).end();
      return;
    }
    const uploaded = await this.cloud.upload({
      workspaceId,
      sessionId,
      traceId,
      body,
    });
    if (uploaded instanceof Error) {
      console.error(uploaded);
      response.writeHead(503).end();
      return;
    }
    response.writeHead(204).end();
  }
}

async function readArchive(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  const received = await pipeline(
    request,
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        size += chunk.byteLength;
        if (size > maxCompressedBytes) {
          callback(
            new TraceArchiveError({ detail: "compressed size limit exceeded" }),
          );
          return;
        }
        chunks.push(chunk);
        callback();
      },
    }),
  ).catch((cause) => new TraceArchiveError({ detail: "read upload", cause }));
  if (received instanceof Error) return received;
  return Buffer.concat(chunks);
}

async function validateArchive(input: {
  body: Buffer;
  workspaceId: string;
  sessionId: string;
  traceId: string;
}) {
  const expanded = await decompress(input.body, {
    maxOutputLength: maxExpandedBytes,
  }).catch(
    (cause) => new TraceArchiveError({ detail: "decompress upload", cause }),
  );
  if (expanded instanceof Error) return expanded;
  const text = expanded.toString("utf8");
  if (!text.endsWith("\n"))
    return new TraceArchiveError({ detail: "unfinished record" });
  const lines = text.slice(0, -1).split("\n");
  if (lines.length < 2)
    return new TraceArchiveError({ detail: "missing run boundaries" });
  for (const [sequence, line] of lines.entries()) {
    const record = errore.try({
      try: () => {
        const parsed: unknown = JSON.parse(line);
        if (!Value.Check(recordSchema, parsed))
          return new TraceArchiveError({ detail: "invalid record envelope" });
        return parsed;
      },
      catch: (cause) =>
        new TraceArchiveError({ detail: "parse record", cause }),
    });
    if (record instanceof Error) return record;
    if (
      record.workspaceId !== input.workspaceId ||
      record.sessionId !== input.sessionId ||
      record.traceId !== input.traceId ||
      record.sequence !== sequence
    )
      return new TraceArchiveError({
        detail: "record identity or sequence mismatch",
      });
    if (
      (sequence === 0 && record.type !== "run.started") ||
      (sequence === lines.length - 1 && record.type !== "run.finished")
    )
      return new TraceArchiveError({ detail: "missing run boundaries" });
  }
}
