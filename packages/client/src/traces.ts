export type TraceAgent = {
  id: string;
  version?: string;
};

export type TraceEvent = {
  type: string;
  spanId: string;
  parentSpanId?: string;
  attributes?: Record<string, string | number | boolean>;
  data?: unknown;
};

export type TraceOutcome = "completed" | "failed" | "cancelled" | "interrupted";

export type TraceRecord = TraceEvent & {
  schemaVersion: 1;
  workspaceId: string;
  sessionId: string;
  traceId: string;
  sequence: number;
  timestamp: string;
};
