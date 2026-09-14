import type { ConnectionRequest } from "./ConnectionRequest.js";
import type { HaloMessage } from "./sessionState.js";

type ToolArguments = Extract<
  Extract<HaloMessage, { role: "assistant" }>["content"][number],
  { type: "toolCall" }
>["arguments"];

type ToolResultDetails = {
  connectionRequests?: ConnectionRequest[];
};

type ToolDescription = {
  path: string;
  arguments?: ToolArguments;
  result?: string;
  isError?: boolean;
};

type ExecDescription = {
  type: "exec";
  js: string;
  tools?: ToolDescription[];
  result?: string;
  isError?: boolean;
};

type ToolStartOptions = {
  id: string;
  arguments?: ToolArguments;
};

export type SessionDescription = {
  title: string;
  messages?: SessionDescriptionItem[];
};

export type SessionDescriptionItem =
  | { type: "user"; text: string }
  | { type: "assistant"; text: string }
  | {
      type: "tool";
      name: string;
      arguments: ToolArguments;
      result: string;
      details?: ToolResultDetails;
    }
  | { type: "connectionRequest"; request: ConnectionRequest }
  | ExecDescription;

type ToolCallDescription = {
  type: "tool.start";
  path: string;
} & ToolStartOptions;

type ToolMessage = Extract<SessionDescriptionItem, { type: "tool" }>;

export type MessageDialect = {
  tool: {
    start(toolPath: string, options: ToolStartOptions): ToolCallDescription;
  };
  user(text: string): Extract<SessionDescriptionItem, { type: "user" }>;
  assistant(
    text: string,
  ): Extract<SessionDescriptionItem, { type: "assistant" }>;
  error(message: string): { type: "error"; message: string };
  read(input: { path: string; result: string }): ToolMessage;
  edit(input: {
    path: string;
    oldText: string;
    newText: string;
    result: string;
  }): ToolMessage;
  write(input: { path: string; content: string; result: string }): ToolMessage;
  patch(input: { patchText: string; result: string }): ToolMessage;
  bash(input: { command: string; result: string }): ToolMessage;
  exec(input: Omit<ExecDescription, "type">): ExecDescription;
  connectionRequest(
    request: ConnectionRequest,
  ): Extract<SessionDescriptionItem, { type: "connectionRequest" }>;
};

export const m: MessageDialect = {
  tool: {
    start(toolPath, options) {
      return { type: "tool.start", path: toolPath, ...options };
    },
  },
  user(text) {
    return { type: "user", text };
  },
  assistant(text) {
    return { type: "assistant", text };
  },
  error(message) {
    return { type: "error", message };
  },
  read(input) {
    return {
      type: "tool",
      name: "read",
      arguments: { path: input.path },
      result: input.result,
    };
  },
  edit(input) {
    return {
      type: "tool",
      name: "edit",
      arguments: {
        path: input.path,
        oldText: input.oldText,
        newText: input.newText,
      },
      result: input.result,
    };
  },
  write(input) {
    return {
      type: "tool",
      name: "write",
      arguments: { path: input.path, content: input.content },
      result: input.result,
    };
  },
  patch(input) {
    return {
      type: "tool",
      name: "patch",
      arguments: { patchText: input.patchText },
      result: input.result,
    };
  },
  bash(input) {
    return {
      type: "tool",
      name: "bash",
      arguments: { command: input.command },
      result: input.result,
    };
  },
  exec(input) {
    return { type: "exec", ...input };
  },
  connectionRequest(request) {
    return { type: "connectionRequest", request };
  },
};
