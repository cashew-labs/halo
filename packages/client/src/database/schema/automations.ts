import { haloSchema } from "./schema.js";
import type {
  Automation,
  AutomationAction,
  AutomationActivation,
  AutomationRunStatus,
  AutomationRunTrigger,
} from "../../automations.js";

// Domain tables remain the source of truth. Times are epoch milliseconds.
export const automations = haloSchema.table({
  table: "halo_automations",
  fields: {
    id: haloSchema.id(),
    extensionId: haloSchema.optional(haloSchema.text("extension_id")),
    name: haloSchema.text(),
    activation: haloSchema.json<AutomationActivation>(),
    revision: haloSchema.number(),
    action: haloSchema.json<AutomationAction>(),
    enabled: haloSchema.boolean(),
    autoArchiveSession: haloSchema.boolean("auto_archive_thread"),
    nextRunAt: haloSchema.optional(haloSchema.number("next_run_at")),
    createdAt: haloSchema.number("created_at"),
    updatedAt: haloSchema.number("updated_at"),
  },
  relations: {
    runs: {
      type: "one-to-many",
      targetCollection: "automationRuns",
      from: "id",
      to: "automationId",
    },
  },
});

export const automationRuns = haloSchema.table({
  table: "halo_automation_runs",
  fields: {
    id: haloSchema.id(),
    automationId: haloSchema.text("automation_id"),
    revision: haloSchema.number(),
    eventId: haloSchema.optional(haloSchema.text("event_id")),
    trigger: haloSchema.text<AutomationRunTrigger>(),
    scheduledFor: haloSchema.number("scheduled_for"),
    sessionId: haloSchema.optional(haloSchema.text("thread_id")),
    status: haloSchema.text<AutomationRunStatus>(),
    startedAt: haloSchema.number("started_at"),
    finishedAt: haloSchema.optional(haloSchema.number("finished_at")),
    error: haloSchema.optional(haloSchema.text()),
    // Explicit insertion order preserves legacy started_at,rowid ties.
    sequence: haloSchema.number(),
    snapshot: haloSchema.optional(haloSchema.json<Automation>()),
    // Keep the exact serialized delivery for deduplication after retention.
    payload: haloSchema.optional(haloSchema.text()),
    payloadHash: haloSchema.optional(haloSchema.text("payload_hash")),
  },
  relations: {},
});

export const automationSync = haloSchema.table({
  table: "halo_automation_sync",
  fields: {
    id: haloSchema.id(),
    generation: haloSchema.number(),
    nextRunSequence: haloSchema.number("next_run_sequence"),
  },
  relations: {},
});

// Frontend and legacy snapshot queries should not select execution data.
export const automationRunSelect = {
  id: true,
  automationId: true,
  revision: true,
  eventId: true,
  trigger: true,
  scheduledFor: true,
  sessionId: true,
  status: true,
  startedAt: true,
  finishedAt: true,
  error: true,
  sequence: true,
} as const;
