import { type Static, type TObject } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import type { ToolRuntime } from "../runtime/ToolRuntime.js";

export class HaloToolInputError extends errore.createTaggedError({
  name: "HaloToolInputError",
  message: 'Invalid input for Halo tool "$tool"',
}) {}

export type HaloToolExecution = {
  value: unknown;
};

export type HaloToolContext = {
  workspaceRoot: string;
  userId: string;
  runtime: ToolRuntime;
  signal: AbortSignal | undefined;
  modelId: string | undefined;
};

export type HaloTool = {
  name: string;
  description: string;
  inputSchema: TObject;
  requiredCapabilities: readonly string[];
  // defineHaloTool validates this Executor boundary against inputSchema.
  execute(
    // oxlint-disable-next-line anti-slop/no-unknown-parameters
    input: unknown,
    context: HaloToolContext,
  ): Promise<HaloToolExecution | Error>;
};

export type HaloToolPlugin = {
  id: string;
  name: string;
  tools: readonly HaloTool[];
  close?: () => Promise<void | Error>;
};

export function defineHaloTool<TInputSchema extends TObject>(input: {
  name: string;
  description: string;
  inputSchema: TInputSchema;
  requiredCapabilities: readonly string[];
  execute(
    input: Static<TInputSchema>,
    context: HaloToolContext,
  ): Promise<HaloToolExecution | Error>;
}): HaloTool {
  return {
    ...input,
    execute: async (value, context) => {
      if (!Value.Check(input.inputSchema, value)) {
        return new HaloToolInputError({ tool: input.name });
      }
      return await input.execute(value, context);
    },
  };
}
