import { type Static, type TObject } from "@sinclair/typebox";
import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import type { FilesystemService } from "../../filesystem/FilesystemService.js";
import type { NativeConnection } from "../../database/DatabaseService.js";
import type { HotkeyService } from "../../hotkeys/HotkeyService.js";
import type { AutomationService } from "../../automations/AutomationService.js";
import type { MemoryService } from "../../memory/MemoryService.js";
import type { AutomationRunner } from "../../automations/AutomationRunner.js";
import type { AutomationSources } from "../../automations/AutomationSources.js";
import type { ThreadManager } from "../../threads/ThreadManager.js";
import type { ConnectionService } from "../runtime/ConnectionService.js";
import type { ParallelSearchService } from "./web/parallelSearch.js";
import type { ToolRuntime } from "../runtime/ToolRuntime.js";
import type { ComputerService } from "../../computer/ComputerService.js";
import type { BrowserService } from "../../browser/BrowserService.js";

export type HaloToolExecution<T = unknown> = {
  result: T;
  modelResult?: ToolExecutionResult;
};

export type HaloToolServices = {
  readonly filesystem: FilesystemService;
  readonly database: NativeConnection;
  readonly hotkeys: HotkeyService;
  readonly automations: AutomationService;
  readonly memory: MemoryService;
  readonly automationRunner: AutomationRunner;
  readonly automationSources: AutomationSources;
  readonly threads: ThreadManager;
  readonly connections: ConnectionService;
  readonly web: ParallelSearchService;
  readonly computer: ComputerService;
  // Absent when the workspace has no Chrome.
  readonly browser: BrowserService | undefined;
};

export type HaloToolContext = {
  workspaceRoot: string;
  userId: string;
  toolPath: string;
  services: HaloToolServices;
  runtime: ToolRuntime;
  signal: AbortSignal | undefined;
  modelId: string | undefined;
  threadId?: string;
  toolCallId?: string;
  bashOutput?: { directory: string; headChars: number; tailChars: number };
};

type ModelTool = {
  name: string;
  replay: "safe" | "unsafe";
};

export type HaloTool<TInputSchema extends TObject = TObject, T = unknown> = {
  description: string;
  inputSchema: TInputSchema;
  requiredCapabilities: readonly string[];
  modelTool?: ModelTool;
  execute(
    input: Static<TInputSchema>,
    context: HaloToolContext,
  ): Promise<HaloToolExecution<T> | Error>;
};

export type HaloTools = {
  readonly [name: string]: HaloTool | HaloTools;
};

export function haloTool<TInputSchema extends TObject, T>(
  input: HaloTool<TInputSchema, T>,
) {
  return input;
}
