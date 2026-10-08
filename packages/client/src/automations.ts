import { Type, type Static } from "@sinclair/typebox";
import * as errore from "errore";
export const automationActionSchema = Type.Union([
  Type.Object({
    type: Type.Literal("runAgent"),
    prompt: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal("runScript"),
    command: Type.String({ minLength: 1 }),
    // Workspace-relative; defaults to the workspace or extension directory.
    cwd: Type.Optional(Type.String({ minLength: 1 })),
  }),
]);
export type AutomationAction = Static<typeof automationActionSchema>;

export const automationActivationSchema = Type.Union([
  Type.Object({
    type: Type.Literal("routine"),
    schedule: Type.Object({
      cron: Type.String({ minLength: 1 }),
      timezone: Type.String({ minLength: 1 }),
    }),
  }),
  Type.Object({
    type: Type.Literal("trigger"),
    trigger: Type.Union([
      Type.Object({ type: Type.Literal("webhook") }),
      Type.Object({
        type: Type.Literal("gmail"),
        connectionAddress: Type.String({ minLength: 1 }),
        event: Type.Literal("messageReceived"),
        from: Type.Optional(Type.String({ minLength: 1 })),
        subjectContains: Type.Optional(Type.String({ minLength: 1 })),
      }),
    ]),
  }),
]);
export type AutomationActivation = Static<typeof automationActivationSchema>;

export const automationInputSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  extensionId: Type.Optional(Type.String({ minLength: 1 })),
  name: Type.String({ minLength: 1, maxLength: 80 }),
  activation: automationActivationSchema,
  action: automationActionSchema,
  enabled: Type.Optional(Type.Boolean()),
  autoArchiveSession: Type.Optional(Type.Boolean()),
});
export type AutomationInput = Static<typeof automationInputSchema>;
export type AutomationRunTrigger = "schedule" | "manual" | "event";
export type AutomationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "interrupted"
  | "cancelled"
  | "skipped";

export type AutomationRun = {
  id: string;
  automationId: string;
  revision: number;
  trigger: AutomationRunTrigger;
  eventId?: string;
  scheduledFor: string;
  sessionId?: string;
  status: AutomationRunStatus;
  startedAt: string;
  finishedAt?: string;
  error?: string;
};

export type Automation = {
  id: string;
  revision: number;
  extensionId?: string;
  name: string;
  activation: AutomationActivation;
  action: AutomationAction;
  enabled: boolean;
  autoArchiveSession: boolean;
  nextRunAt?: string;
  createdAt: string;
  updatedAt: string;
  lastRun?: AutomationRun;
};

export class InvalidAutomationError extends errore.createTaggedError({
  name: "InvalidAutomationError",
  message: "$reason",
}) {}

export const automationEventSchema = Type.Object({
  eventId: Type.String({ minLength: 1, maxLength: 200 }),
  automationId: Type.String({ minLength: 1 }),
  revision: Type.Integer({ minimum: 1 }),
  source: Type.Union([Type.Literal("webhook"), Type.Literal("gmail")]),
  occurredAt: Type.String({ minLength: 1 }),
  payload: Type.Record(Type.String(), Type.Unknown()),
});
export type AutomationEvent = Static<typeof automationEventSchema>;
