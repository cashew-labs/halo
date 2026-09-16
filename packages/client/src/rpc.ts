export type { HaloMessage } from "./sessionState.js";
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
};

export type WorkspaceTreeEvent =
  | { type: "create"; path: string }
  | { type: "delete"; path: string };

export type WorkspaceFilePreview =
  | { kind: "text" }
  | { kind: "image" | "pdf" | "audio" | "video"; file: File }
  | { kind: "unsupported"; reason: string };
