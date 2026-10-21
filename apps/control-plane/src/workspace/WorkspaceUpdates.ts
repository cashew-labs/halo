import * as errore from "errore";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { SqlDatabase } from "../database/SqlDatabase.js";
import type { WorkspaceService } from "./WorkspaceService.js";
import type {
  WorkspaceUpdateStatus,
  WorkspaceUpgradeResult,
} from "@get-halo/shared/controlPlaneContract";

export const workspaceUpdateReportSchema = Type.Object(
  {
    state: Type.Union([
      Type.Literal("current"),
      Type.Literal("available"),
      Type.Literal("downloading"),
      Type.Literal("ready"),
      Type.Literal("upgrading"),
      Type.Literal("failed"),
    ]),
    version: Type.String({ minLength: 1, maxLength: 128 }),
    targetVersion: Type.String({ maxLength: 128 }),
    busy: Type.Boolean(),
    error: Type.Optional(Type.String({ maxLength: 1024 })),
  },
  { additionalProperties: false },
);
type WorkspaceUpdateReport = Static<typeof workspaceUpdateReportSchema>;
export type WorkspaceUpdateTarget = { image: string; version: string };
class WorkspaceUpdateError extends errore.createTaggedError({
  name: "WorkspaceUpdateError",
  message: "$message",
}) {}

type UpdateRow = {
  report: string;
  reported_at: string | number;
  request_version: string;
  force: number;
  request_at: string | number;
};

/** Persists maintenance independently of the container being replaced. */
export class WorkspaceUpdates {
  private readonly database: SqlDatabase;
  private readonly workspace: WorkspaceService;
  private readonly target: WorkspaceUpdateTarget | undefined;
  private readonly registryToken: (() => Promise<string | Error>) | undefined;
  private readonly idleMs: number;

  constructor(ctx: {
    database: SqlDatabase;
    workspace: WorkspaceService;
    target?: WorkspaceUpdateTarget;
    registryToken?: () => Promise<string | Error>;
    idleMs?: number;
  }) {
    this.database = ctx.database;
    this.workspace = ctx.workspace;
    this.target = ctx.target;
    this.registryToken = ctx.registryToken;
    this.idleMs = ctx.idleMs ?? 5 * 60_000;
  }

  async initialize() {
    return await this.database
      .query(`CREATE TABLE IF NOT EXISTS workspace_updates (
      workspace_id TEXT PRIMARY KEY, report TEXT NOT NULL, reported_at BIGINT NOT NULL,
      request_version TEXT NOT NULL DEFAULT '', force INTEGER NOT NULL DEFAULT 0,
      request_at BIGINT NOT NULL DEFAULT 0, state TEXT NOT NULL DEFAULT 'current')`);
  }

  async status(
    userId: string,
  ): Promise<WorkspaceUpdateStatus | Error | undefined> {
    const workspace = await this.workspace.ensureIdentity(userId);
    if (workspace instanceof Error) return workspace;
    const row = await this.read(workspace.id);
    if (row instanceof Error || row === undefined || this.target === undefined)
      return row instanceof Error ? row : undefined;
    const report = this.parse(row.report);
    if (report instanceof Error) return report;
    if (
      report.state === "upgrading" &&
      Date.now() - Number(row.reported_at) > 180_000
    )
      return {
        ...report,
        targetVersion: this.target.version,
        reportedAt: Number(row.reported_at),
        state: "failed",
        error:
          "Workspace update progress was interrupted. Reconnect, then try updating again.",
      };
    return {
      ...report,
      error:
        report.state === "failed" && this.requested(row)
          ? undefined
          : report.error,
      targetVersion: this.target.version,
      reportedAt: Number(row.reported_at),
      state:
        report.version === this.target.version
          ? "current"
          : report.state === "current" ||
              (report.state === "failed" && this.requested(row))
            ? "available"
            : report.state,
    };
  }

  async request(
    userId: string,
    force: boolean,
  ): Promise<WorkspaceUpgradeResult | Error> {
    if (this.target === undefined) return { status: "current" };
    const workspace = await this.workspace.ensureIdentity(userId);
    if (workspace instanceof Error) return workspace;
    const row = await this.read(workspace.id);
    if (row instanceof Error) return row;
    if (row === undefined) return { status: "checking" };
    const report = this.parse(row.report);
    if (report instanceof Error) return report;
    const age = Date.now() - Number(row.reported_at);
    if (report.state === "upgrading" && age <= 180_000)
      return { status: "started" };
    if (age > 60_000) return { status: "checking" };
    if (report.version === this.target.version) return { status: "current" };
    if (report.busy && !force) {
      // A request made while idle must not survive a later interruption prompt.
      const cleared = await this.database.query(
        "UPDATE workspace_updates SET request_version='', request_at=0 WHERE workspace_id=$1 AND force=0",
        [workspace.id],
      );
      if (cleared instanceof Error) return cleared;
      return { status: "busy" };
    }
    const saved = await this.database.query(
      "UPDATE workspace_updates SET request_version=$2, force=$3, request_at=$4 WHERE workspace_id=$1 RETURNING workspace_id",
      [workspace.id, this.target.version, force ? 1 : 0, Date.now()],
    );
    if (saved instanceof Error) return saved;
    return { status: "started" };
  }

  async cancel(userId: string) {
    const workspace = await this.workspace.ensureIdentity(userId);
    if (workspace instanceof Error) return workspace;
    const cleared = await this.database.query(
      "UPDATE workspace_updates SET request_version='', force=0, request_at=0 WHERE workspace_id=$1",
      [workspace.id],
    );
    if (cleared instanceof Error) return cleared;
  }

  async report(headers: Headers, report: WorkspaceUpdateReport) {
    const identity = await this.workspace.authenticateRuntimeOwner(headers);
    if (identity instanceof Error) return identity;
    const saved = await this.database.query<UpdateRow>(
      `INSERT INTO workspace_updates (workspace_id,report,reported_at,state)
      VALUES ($1,$2,$3,$5) ON CONFLICT (workspace_id) DO UPDATE SET report=$2, reported_at=$3, state=$5,
      request_version=CASE WHEN $4=1 OR ($5='failed' AND workspace_updates.state<>'failed') THEN '' ELSE workspace_updates.request_version END,
      force=CASE WHEN $4=1 OR ($5='failed' AND workspace_updates.state<>'failed') THEN 0 ELSE workspace_updates.force END,
      request_at=CASE WHEN $4=1 OR ($5='failed' AND workspace_updates.state<>'failed') THEN 0 ELSE workspace_updates.request_at END
      RETURNING report,reported_at,request_version,force,request_at`,
      [
        identity.workspaceId,
        JSON.stringify(report),
        Date.now(),
        report.state === "upgrading" || report.version === this.target?.version
          ? 1
          : 0,
        report.state,
      ],
    );
    if (saved instanceof Error) return saved;
    if (report.state === "upgrading") {
      // A container restart must finish before the normal idle VM pause.
      const held = await this.workspace.reportIdle(headers, false);
      if (held instanceof Error) return held;
    }
    if (this.target === undefined || report.version === this.target.version)
      return {};
    const row = saved[0]!;
    const manual = this.requested(row);
    const inactive = await this.workspace.inactiveFor(
      identity.ownerUserId,
      this.idleMs,
    );
    if (inactive instanceof Error) return inactive;
    return {
      target: this.target,
      activate: manual || (inactive && !report.busy),
      force: manual && row.force === 1,
      requestId: manual ? Number(row.request_at) : 0,
    };
  }

  async token(headers: Headers) {
    const identity = await this.workspace.authenticateRuntimeOwner(headers);
    if (identity instanceof Error) return identity;
    if (this.target === undefined || this.registryToken === undefined)
      return new WorkspaceUpdateError({
        message: "Workspace updates are not configured.",
      });
    return await this.registryToken();
  }

  private async read(workspaceId: string) {
    const rows = await this.database.query<UpdateRow>(
      "SELECT report,reported_at,request_version,force,request_at FROM workspace_updates WHERE workspace_id=$1",
      [workspaceId],
    );
    if (rows instanceof Error) return rows;
    return rows[0];
  }

  private requested(row: UpdateRow) {
    // Consent cannot outlive the frontend's bounded update attempt.
    return (
      this.target !== undefined &&
      row.request_version === this.target.version &&
      Date.now() - Number(row.request_at) < 20 * 60_000
    );
  }

  private parse(text: string) {
    return errore.try({
      try: () => {
        const parsed: unknown = JSON.parse(text);
        if (!Value.Check(workspaceUpdateReportSchema, parsed))
          return new WorkspaceUpdateError({
            message: "Could not read workspace update progress.",
          });
        return parsed;
      },
      catch: (cause) =>
        new WorkspaceUpdateError({
          message: "Could not read workspace update progress.",
          cause,
        }),
    });
  }
}
