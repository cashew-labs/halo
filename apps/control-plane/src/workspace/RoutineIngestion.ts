import type { IncomingMessage, ServerResponse } from "node:http";
import type { RoutineScheduleSnapshot } from "@get-halo/client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { TraceCloud, TraceIdentityError } from "../traces/TraceCloud.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import type { RoutineCoordinator } from "./RoutineCoordinator.js";

const maxBodyBytes = 256 * 1024;
const snapshotSchema = Type.Object({
  busy: Type.Boolean(),
  routines: Type.Array(
    Type.Object({
      id: Type.String({ minLength: 1, maxLength: 128 }),
      nextRunAt: Type.Optional(Type.String()),
    }),
    { maxItems: 1_000 },
  ),
});

class RoutineIngestionError extends errore.createTaggedError({
  name: "RoutineIngestionError",
  message: "Could not read workspace routine snapshot.",
}) {}

export class RoutineIngestion {
  private readonly cloud: TraceCloud;
  private readonly workspace: WorkspaceService;
  private readonly coordinator: RoutineCoordinator;
  private readonly audience: string;

  constructor(ctx: {
    cloud: TraceCloud;
    workspace: WorkspaceService;
    coordinator: RoutineCoordinator;
    origin: string;
  }) {
    this.cloud = ctx.cloud;
    this.workspace = ctx.workspace;
    this.coordinator = ctx.coordinator;
    this.audience = new URL("/api/routines/snapshot", ctx.origin).toString();
  }

  async serve(request: IncomingMessage, response: ServerResponse) {
    if (
      request.method !== "POST" ||
      request.headers["content-type"] !== "application/json"
    ) {
      response.writeHead(400).end();
      return;
    }
    const workspaceId = await this.cloud.authenticate(
      request.headers.authorization,
      this.audience,
    );
    if (workspaceId instanceof TraceIdentityError) {
      response.writeHead(401).end();
      return;
    }
    if (workspaceId instanceof Error) {
      console.error(workspaceId);
      response.writeHead(503).end();
      return;
    }
    const registered = await this.workspace.hasWorkspace(workspaceId);
    if (registered instanceof Error) {
      console.error(registered);
      response.writeHead(503).end();
      return;
    }
    if (!registered) {
      response.writeHead(403).end();
      return;
    }
    const snapshot = await readSnapshot(request);
    if (snapshot instanceof Error) {
      response.writeHead(400).end();
      return;
    }
    const updated = await this.coordinator.update(workspaceId, snapshot);
    if (updated instanceof Error) {
      console.error(updated);
      response.writeHead(503).end();
      return;
    }
    response.writeHead(204).end();
  }
}

async function readSnapshot(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  const read = await errore.tryAsync({
    try: async () => {
      for await (const chunk of request) {
        size += chunk.byteLength;
        if (size > maxBodyBytes) return new RoutineIngestionError();
        chunks.push(Buffer.from(chunk));
      }
    },
    catch: (cause) => new RoutineIngestionError({ cause }),
  });
  if (read instanceof Error) return read;
  const parsed = errore.try({
    // SAFETY: The parsed value stays unknown until the schema check below.
    try: () => JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
    catch: (cause) => new RoutineIngestionError({ cause }),
  });
  if (!Value.Check(snapshotSchema, parsed)) return new RoutineIngestionError();
  if (
    parsed.routines.some(
      (routine) =>
        routine.nextRunAt !== undefined &&
        !Number.isFinite(Date.parse(routine.nextRunAt)),
    )
  )
    return new RoutineIngestionError();
  return parsed satisfies RoutineScheduleSnapshot;
}
