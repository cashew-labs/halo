import { IncomingMessage, ServerResponse } from "node:http";
import { Socket } from "node:net";
import { gzipSync } from "node:zlib";
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
