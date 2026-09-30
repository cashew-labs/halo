import type {
  RoutineAction,
  RoutineRunStatus,
  RoutineRunTrigger,
} from "@get-halo/client";
import { haloSchema } from "@get-halo/schema";

export const routines = haloSchema.table({
  table: "halo_routine_definitions",
  fields: {
    id: haloSchema.id(),
    extensionId: haloSchema.optional(haloSchema.text("extension_id")),
    name: haloSchema.text(),
    cron: haloSchema.text(),
    timezone: haloSchema.text(),
    action: haloSchema.json<RoutineAction>(),
    enabled: haloSchema.boolean(),
    autoArchiveSession: haloSchema.boolean("auto_archive_session"),
    nextRunAt: haloSchema.optional(haloSchema.text("next_run_at")),
    createdAt: haloSchema.text("created_at"),
    updatedAt: haloSchema.text("updated_at"),
    lastRunId: haloSchema.optional(haloSchema.text("last_run_id")),
    runSequence: haloSchema.number("run_sequence"),
  },
  relations: {
    lastRun: {
      type: "many-to-one",
      targetCollection: "routineRuns",
      from: "lastRunId",
      to: "id",
    },
    runs: {
      type: "one-to-many",
      targetCollection: "routineRuns",
      from: "id",
      to: "routineId",
    },
  },
});

export const routineRuns = haloSchema.table({
  table: "halo_routine_history",
  fields: {
    id: haloSchema.id(),
    routineId: haloSchema.text("routine_id"),
    trigger: haloSchema.text<RoutineRunTrigger>(),
    scheduledFor: haloSchema.text("scheduled_for"),
    sessionId: haloSchema.optional(haloSchema.text("session_id")),
    status: haloSchema.text<RoutineRunStatus>(),
    startedAt: haloSchema.text("started_at"),
    finishedAt: haloSchema.optional(haloSchema.text("finished_at")),
    error: haloSchema.optional(haloSchema.text()),
    sequence: haloSchema.number(),
  },
  relations: {
    routine: {
      type: "many-to-one",
      targetCollection: "routines",
      from: "routineId",
      to: "id",
    },
  },
});
