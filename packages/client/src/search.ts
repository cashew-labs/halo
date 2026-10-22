// Legacy discriminators and ID keys are part of the supported RPC format.
export type WorkspaceSearchHit = {
  kind: "file" | "session";
  path?: string;
  sessionId?: string;
  title: string;
  snippet: string;
  snippetMatch: { start: number; end: number };
  source: "name" | "content";
  matchIndex: number;
  segmentId?: string;
  offset?: number;
};

export type WorkspaceSearchResponse = {
  hits: WorkspaceSearchHit[];
  skippedOversizedFiles: number;
  truncated: boolean;
};
