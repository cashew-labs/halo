export type WorkspaceInfo = {
  name: string;
  workspaceRoot: string;
};

export type SessionSummary = {
  sessionId: string;
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

export function isThreadUnread(summary: SessionSummary) {
  if (summary.latestResultId === undefined) return false;
  return summary.readReceiptCursorId !== summary.latestResultId;
}

export type SessionSummariesUpdate =
  | { type: "snapshot"; sessions: SessionSummary[] }
  | { type: "updated"; session: SessionSummary };

export type WorkspaceTreeEvent =
  | { type: "create"; path: string }
  | { type: "delete"; path: string };

export type WorkspaceFilePreview =
  | { kind: "text" }
  | { kind: "image" | "pdf" | "audio" | "video"; file: File }
  | { kind: "unsupported"; reason: string };
