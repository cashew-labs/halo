import type { RoutineAction } from "@get-halo/client";
import { defineTable } from "./defineTable.js";
import * as field from "./fields.js";

export const routines = defineTable({
  table: "halo_routine_definitions",
  fields: {
    id: field.id(),
    extensionId: field.optional(field.text("extension_id")),
    name: field.text(),
    cron: field.text(),
    timezone: field.text(),
    action: field.json<RoutineAction>(),
    enabled: field.booleanInteger(),
    autoArchiveSession: field.booleanInteger("auto_archive_session"),
    nextRunAt: field.optional(field.text("next_run_at")),
    createdAt: field.text("created_at"),
    updatedAt: field.text("updated_at"),
    lastRunId: field.optional(field.text("last_run_id")),
    runSequence: field.number("run_sequence"),
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
