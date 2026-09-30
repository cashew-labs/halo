import type { RoutineRunStatus, RoutineRunTrigger } from "@get-halo/client";
import { defineTable } from "./defineTable.js";
import * as field from "./fields.js";

export const routineRuns = defineTable({
  table: "halo_routine_history",
  fields: {
    id: field.id(),
    routineId: field.text("routine_id"),
    trigger: field.text<RoutineRunTrigger>(),
    scheduledFor: field.text("scheduled_for"),
    sessionId: field.optional(field.text("session_id")),
    status: field.text<RoutineRunStatus>(),
    startedAt: field.text("started_at"),
    finishedAt: field.optional(field.text("finished_at")),
    error: field.optional(field.text()),
    sequence: field.number(),
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
