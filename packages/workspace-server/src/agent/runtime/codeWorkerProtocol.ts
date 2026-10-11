import type { ExecuteResult } from "@executor-js/codemode-core";

export type CodeWorkerRequest =
  | { type: "evaluate"; id: string; code: string }
  | { type: "toolResult"; id: string; invocationId: string; value: unknown };

export type CodeWorkerResponse =
  | {
      type: "toolCall";
      id: string;
      invocationId: string;
      path: string;
      args: unknown;
    }
  | { type: "completed"; id: string; result: ExecuteResult; reset: boolean };
