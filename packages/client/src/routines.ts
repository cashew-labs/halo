import { Type, type Static } from "@sinclair/typebox";
import * as errore from "errore";

export const routineActionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("runAgent"),
    prompt: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal("runScript"),
    command: Type.String({ minLength: 1 }),
    // Workspace-relative; defaults to the extension's directory.
    cwd: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);
export type RoutineAction = Static<typeof routineActionSchema>;

export const routineInputSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  extensionId: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  cron: Type.String({ minLength: 1 }),
  timezone: Type.String({ minLength: 1 }),
  action: routineActionSchema,
  enabled: Type.Optional(Type.Boolean()),
});
export type RoutineInput = Static<typeof routineInputSchema>;

export type RoutineRunTrigger = "schedule" | "manual";
export type RoutineRunStatus =
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "skipped";

export type RoutineRun = {
  id: string;
  routineId: string;
  trigger: RoutineRunTrigger;
  scheduledFor: string;
  sessionId?: string;
  status: RoutineRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

export type Routine = {
  id: string;
  extensionId: string;
  name: string;
  cron: string;
  timezone: string;
  action: RoutineAction;
  enabled: boolean;
  // Absent while the routine is paused.
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  // The latest run that started; skipped runs appear only in run history.
  lastRun?: RoutineRun;
};

export class InvalidRoutineError extends errore.createTaggedError({
  name: "InvalidRoutineError",
  message: "$reason",
}) {}
