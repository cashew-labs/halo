import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import * as errore from "errore";
import { ControlPlaneTraceUploader } from "../../../../../packages/workspace-server/src/traces/ControlPlaneTraceUploader.js";
import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { gunzipSync, gzipSync } from "node:zlib";
import { GoogleAuth } from "google-auth-library";
import { expect, test, vi } from "vitest";
import { traceUploadLimits } from "@get-halo/client/traces";
import type { WorkspaceService } from "../../workspace/WorkspaceService.js";
import { TraceCloud } from "../TraceCloud.js";
import { TraceIngestion } from "../TraceIngestion.js";

const workspaceId = "workspace";
const traceId = "a".repeat(32);
const archive = gzipSync(
  ["run.started", "run.finished"]
    .map((type, sequence) =>
      JSON.stringify({
        schemaVersion: 1,
        workspaceId,
        sessionId: "session",
        traceId,
        spanId: "b".repeat(16),
        sequence,
        timestamp: new Date().toISOString(),
        type,
      }),
    )
    .join("\n") + "\n",
);

for (const scenario of ["valid", "compressed", "expanded"] as const) {
  test(`ingestion enforces shared limits (${scenario})`, async () => {
    // The unit boundary substitutes authentication and cloud storage only.
    const workspace = {
      authenticateRuntime: async () => ({ workspaceId }),
    } as WorkspaceService;
    const cloud = new TraceCloud({ bucket: "test", auth: new GoogleAuth() });
    const store = vi.spyOn(cloud, "upload").mockResolvedValue(undefined);
    const socket = new Socket();
    const request = new IncomingMessage(socket);
    const response = new ServerResponse(request);
    request.method = "POST";
    request.headers["content-type"] = "application/gzip";
    const body =
      scenario === "valid"
        ? archive
        : scenario === "compressed"
          ? Buffer.alloc(traceUploadLimits.compressedBytes + 1)
          : gzipSync(Buffer.alloc(traceUploadLimits.expandedBytes + 1));
    request.push(body);
    request.push(null);
    try {
      await new TraceIngestion({ workspace, cloud }).serve(
        request,
        response,
        new URL(`http://localhost/api/traces/session/${traceId}`),
      );
      expect(response.statusCode).toBe(scenario === "valid" ? 204 : 400);
      expect(store).toHaveBeenCalledTimes(scenario === "valid" ? 1 : 0);
      if (scenario === "valid")
        expect(store).toHaveBeenCalledWith({
          workspaceId,
          sessionId: "session",
          traceId,
          body: archive,
        });
    } finally {
      store.mockRestore();
      socket.destroy();
    }
  });
}

test("accepts an oversized archive's preview through the real HTTP ingestion endpoint", async () => {
  const directory = path.resolve(
    import.meta.dirname,
    "../../../../../tmp/billing-investigation/tests",
    randomUUID(),
  );
  await fs.mkdir(directory, { recursive: true });
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(
    async () => await fs.rm(directory, { recursive: true, force: true }),
  );
  const filePath = path.join(directory, "oversized.jsonl.gz");
  const first = gunzipSync(archive).toString().split("\n")[0]! + "\n";
  await fs.writeFile(
    filePath,
    gzipSync(
      first +
        JSON.stringify({ data: "x".repeat(traceUploadLimits.expandedBytes) }) +
        "\n",
    ),
  );
  const stored: Buffer[] = [];
  const cloud = new TraceCloud({ bucket: "test", auth: new GoogleAuth() });
  vi.spyOn(cloud, "upload").mockImplementation(async ({ body }) => {
    stored.push(body);
  });
  const workspace = {
    authenticateRuntime: async () => ({ workspaceId }),
  } as WorkspaceService;
  const ingestion = new TraceIngestion({ workspace, cloud });
  const server = http.createServer(async (request, response) => {
    await ingestion.serve(
      request,
      response,
      new URL(request.url!, "http://localhost"),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.defer(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) =>
        error === undefined ? resolve() : reject(error),
      ),
    );
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Missing listener");
  const uploader = new ControlPlaneTraceUploader({
    origin: `http://127.0.0.1:${address.port}`,
    token: "test-runtime",
  });
  expect(
    await uploader.upload({
      key: `v1/workspaces/${workspaceId}/sessions/session/${traceId}.jsonl.gz`,
      filePath,
    }),
  ).toMatchObject({ partial: true, reason: "expanded size limit exceeded" });
  expect(stored).toHaveLength(1);
  const records = gunzipSync(stored[0]!)
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records[1].data.preview).toBe(first);
  expect(records[1].data.reason).toBe("expanded size limit exceeded");
  expect(records[2].data.fullArchiveUploaded).toBe(false);
});
