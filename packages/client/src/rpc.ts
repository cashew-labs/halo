export type WorkspaceInfo = {
  name: string;
  workspaceRoot: string;
};

// Serialized field names stay compatible with existing clients.
export type ThreadSummary = {
  sessionId: string;
  agentId?: string;
  agent: "pi";
  cwd: string;
  title?: string;
  createdAt: string;
  updatedAt: string;
  isRunning: boolean;
  latestResultId?: string;
  markedDone: boolean;
  readReceiptCursorId?: string;
};

export function isThreadUnread(summary: ThreadSummary) {
  if (summary.latestResultId === undefined) return false;
  return summary.readReceiptCursorId !== summary.latestResultId;
}

export type ThreadSummariesUpdate =
  | { type: "snapshot"; sessions: ThreadSummary[] }
  | { type: "updated"; session: ThreadSummary };

export type WorkspaceTreeEvent =
  | { type: "create"; path: string }
  | { type: "delete"; path: string };

export type WorkspaceFilePreview =
  | { kind: "text"; content: string }
  | { kind: "image" | "pdf" | "audio" | "video"; file: File }
  | { kind: "unsupported"; reason: string };
