import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { copyJson } from "@earendil-works/chord";
import type {
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { execToolCallSchema } from "@get-halo/client";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

const maxPreviewChars = 40_000;
const headChars = 8_000;
const tailChars = 32_000;
const execDetailsSchema = Type.Object({
  toolCalls: Type.Array(execToolCallSchema),
});
const streamedBashDetailsSchema = Type.Object({
  truncated: Type.Literal(true),
  fullOutputPath: Type.String(),
});

class SaveToolOutputError extends errore.createTaggedError({
  name: "SaveToolOutputError",
  message: "Could not save the full tool output",
}) {}

function textContent(result: ToolExecutionResult) {
  return (result.content ?? [])
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
}

function preview(content: string, notice: string) {
  const omittedChars = content.length - headChars - tailChars;
  return `${content.slice(0, headChars)}\n\n[${omittedChars.toLocaleString()} characters omitted from the middle. ${notice}]\n\n${content.slice(-tailChars)}`;
}

async function saveOutput(input: {
  workspaceRoot: string;
  sessionId: string;
  toolName: string;
  content: string;
}) {
  const directory = path.join(
    input.workspaceRoot,
    ".halo",
    "tool-outputs",
    input.sessionId,
  );
  const outputFile = path.join(
    directory,
    `${input.toolName}-${randomUUID()}.txt`,
  );
  const created = await fs
    .mkdir(directory, { recursive: true, mode: 0o700 })
    .catch((cause) => new SaveToolOutputError({ cause }));
  if (created instanceof Error) return created;
  const written = await fs
    .writeFile(outputFile, input.content, { mode: 0o600 })
    .catch((cause) => new SaveToolOutputError({ cause }));
  if (written instanceof Error) return written;
  return outputFile;
}

export function limitToolOutput(
  tool: ToolRegistration,
  input: { workspaceRoot: string; sessionId: string },
): ToolRegistration {
  return {
    ...tool,
    async execute(args, api, context) {
      const result = await tool.execute(args, api, context);
      if (
        tool.name === "bash" &&
        Value.Check(streamedBashDetailsSchema, result.details)
      )
        return result;
      const fullText = textContent(result);
      if (fullText.length <= maxPreviewChars) return result;

      const outputFile = await saveOutput({
        ...input,
        toolName: tool.name,
        content: fullText,
      });
      if (outputFile instanceof Error)
        console.warn("Failed to save full tool output:", outputFile);

      const notice =
        outputFile instanceof Error
          ? "Full output could not be saved. Run a narrower query to inspect the omitted content."
          : `Full output: ${outputFile}. Search that file or read a narrow range to inspect the omitted content. Results from those tools are also capped.`;

      return {
        ...result,
        content: [
          { type: "text", text: preview(fullText, notice) },
          ...(result.content ?? []).filter((part) => part.type !== "text"),
        ],
        ...(outputFile instanceof Error
          ? tool.name === "exec" &&
            Value.Check(execDetailsSchema, result.details)
            ? {
                details: copyJson(
                  { toolCalls: result.details.toolCalls },
                  { omitUndefinedProperties: true },
                ),
              }
            : {}
          : {
              details: copyJson(
                tool.name === "exec" &&
                  Value.Check(execDetailsSchema, result.details)
                  ? {
                      toolCalls: result.details.toolCalls,
                      fullOutputPath: outputFile,
                    }
                  : { fullOutputPath: outputFile },
                { omitUndefinedProperties: true },
              ),
            }),
      };
    },
  };
}
