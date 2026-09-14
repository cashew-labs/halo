import type { SessionDescription } from "@get-halo/shared/testing";
import crypto from "node:crypto";
import type {
  HaloMessage,
  ExecToolCall,
  ToolIdentity,
} from "@get-halo/shared/sessionState";
import * as errore from "errore";

class LoadSessionError extends errore.createTaggedError({
  name: "LoadSessionError",
  message: "Could not load the described E2E session",
}) {}

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
  },
};

export async function loadSessionDescription(args: {
  description: SessionDescription;
  load(input: {
    title: string;
    messages: HaloMessage[];
  }): Promise<{ sessionId: string }>;
  getToolIdentity(path: string): Promise<ToolIdentity>;
}) {
  const messages: HaloMessage[] = [];
  const items =
    args.description.messages === undefined ? [] : args.description.messages;
  let timestamp = Date.now();
  for (const item of items) {
    timestamp += 1;
    if (item.type === "user") {
      messages.push({ role: "user", content: item.text, timestamp });
      continue;
    }
    if (item.type === "assistant") {
      messages.push(
        assistantMessage({
          content: [{ type: "text", text: item.text }],
          stopReason: "stop",
          timestamp,
        }),
      );
      continue;
    }
    const id = crypto.randomUUID();
    const name = item.type === "tool" ? item.name : "exec";
    const toolArguments =
      item.type === "tool"
        ? item.arguments
        : { js: item.type === "exec" ? item.js : "" };
    const toolCalls: ExecToolCall[] = [];
    if (item.type === "exec" && item.tools !== undefined) {
      for (const call of item.tools) {
        const tool = await args
          .getToolIdentity(call.path)
          .catch((cause) => new LoadSessionError({ cause }));
        if (tool instanceof Error) return tool;
        toolCalls.push({
          id: crypto.randomUUID(),
          parentId: id,
          tool,
          arguments: call.arguments === undefined ? {} : call.arguments,
          status: call.isError === true ? "failed" : "completed",
        });
      }
    }
    messages.push(
      assistantMessage({
        content: [{ type: "toolCall", id, name, arguments: toolArguments }],
        stopReason: "toolUse",
        timestamp,
      }),
    );
    timestamp += 1;
    const result =
      item.type === "connectionRequest" ? "Connection required" : item.result;
    const details =
      item.type === "connectionRequest"
        ? { connectionRequests: [item.request] }
        : item.type === "exec"
          ? { toolCalls }
          : item.details;
    messages.push({
      role: "toolResult",
      toolCallId: id,
      toolName: name,
      content: result === undefined ? [] : [{ type: "text", text: result }],
      details,
      isError: item.type === "exec" && item.isError === true,
      timestamp,
    });
  }
  return await args
    .load({ title: args.description.title, messages })
    .catch((cause) => new LoadSessionError({ cause }));
}

function assistantMessage(args: {
  content: Extract<HaloMessage, { role: "assistant" }>["content"];
  stopReason: Extract<HaloMessage, { role: "assistant" }>["stopReason"];
  timestamp: number;
}): Extract<HaloMessage, { role: "assistant" }> {
  return {
    role: "assistant",
    content: args.content,
    api: "openai-codex-responses",
    provider: "openai-codex",
    model: "gpt-5.6-terra",
    usage: emptyUsage,
    stopReason: args.stopReason,
    timestamp: args.timestamp,
  };
}
