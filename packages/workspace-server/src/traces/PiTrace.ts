import {
  createAssistantMessageEventStream,
  type Context,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import type { AgentHarness, HarnessEvent } from "@earendil-works/pi-agent-core";
import type { TraceEvent } from "@get-halo/client";
import type { LLMApi } from "../llm/LLMApi.js";
import type { ExecActivityUpdate } from "../agent/runtime/ToolRuntime.js";
import { RunTrace } from "./RunTrace.js";
import type { TraceService } from "./TraceService.js";
import manifest from "../../package.json" with { type: "json" };

export class PiTrace {
  // The main lane owns at most one active run in this session.
  private run: RunTrace | undefined;
  // Correlates Pi and Executor tool IDs with trace span IDs.
  private readonly tools = new Map<string, string>();

  private readonly service: TraceService;
  private readonly sessionId: string;
  private readonly llmApi: LLMApi;

  constructor(ctx: {
    service: TraceService;
    sessionId: string;
    llmApi: LLMApi;
  }) {
    const { service, sessionId, llmApi } = ctx;
    this.service = service;
    this.sessionId = sessionId;
    this.llmApi = llmApi;
  }

  api(): LLMApi {
    return {
      model: this.llmApi.model,
      stream: (context, options) => this.stream(context, options),
    };
  }

  attach(harness: AgentHarness) {
    harness.events.on("run_start", async (event) => {
      const run = await this.service.start({
        sessionId: this.sessionId,
        agent: { id: "halo" },
        data: {
          ...event,
          piVersion: manifest.dependencies["@earendil-works/pi-agent-core"],
        },
      });
      if (run instanceof Error) {
        this.service.report(run);
        return;
      }
      this.run = run;
    });
    harness.events.on("run_end", async (event) => {
      await this.event(event);
      const run = this.run;
      this.run = undefined;
      this.tools.clear();
      if (run === undefined) return;
      const outcome = event.status === "aborted" ? "cancelled" : event.status;
      const finished = await this.service.finish(run.traceId, outcome);
      if (finished instanceof Error) this.service.report(finished);
    });
    harness.events.on("tool_start", async (event) => {
      const run = this.run;
      if (run === undefined) return;
      const spanId = RunTrace.spanId();
      this.tools.set(event.toolCallId, spanId);
      await this.record(run, {
        type: "tool.started",
        spanId,
        parentSpanId: run.spanId,
        attributes: {
          "gen_ai.operation.name": "execute_tool",
          "gen_ai.tool.name": event.toolName,
          "gen_ai.tool.call.id": event.toolCallId,
        },
        data: event,
      });
    });
    harness.events.on("tool_end", async (event) => {
      const run = this.run;
      const spanId = this.tools.get(event.toolCallId);
      if (run === undefined || spanId === undefined) return;
      await this.record(run, {
        type: "tool.finished",
        spanId,
        parentSpanId: run.spanId,
        data: event,
      });
      this.tools.delete(event.toolCallId);
    });
    for (const type of [
      "entry_added",
      "queue_update",
      "compaction_start",
      "compaction_end",
      "retry_scheduled",
      "retry_end",
      "fault",
      "config_update",
      "operation_abort",
    ] as const) {
      harness.events.on(type, async (event) => await this.event(event));
    }
  }

  integration(event: ExecActivityUpdate) {
    const run = this.run;
    if (run === undefined) return;
    if (event.type === "tool.started") {
      const parentSpanId = this.tools.get(event.invocation.parentId);
      const spanId = RunTrace.spanId();
      this.tools.set(event.invocation.id, spanId);
      // oxlint-disable-next-line typescript/no-floating-promises -- record() queues the snapshot synchronously and reports storage errors; the run's final write drains earlier records.
      this.record(run, {
        type: "integration.started",
        spanId,
        parentSpanId,
        data: event,
      });
      return;
    }
    const spanId = this.tools.get(event.invocationId);
    if (spanId === undefined) return;
    // oxlint-disable-next-line typescript/no-floating-promises -- Executor callbacks are synchronous; run finalization waits for this queued record.
    this.record(run, { type: "integration.finished", spanId, data: event });
    this.tools.delete(event.invocationId);
  }

  private async event(event: HarnessEvent) {
    if (this.run === undefined) return;
    await this.record(this.run, {
      type: `pi.${event.type}`,
      spanId: this.run.spanId,
      data: event,
    });
  }

  private async record(run: RunTrace, event: TraceEvent) {
    const written = await run.record(event);
    if (written instanceof Error) this.service.report(written);
  }

  private stream(context: Context, options?: SimpleStreamOptions) {
    const run = this.run;
    if (run === undefined) return this.llmApi.stream(context, options);
    const spanId = RunTrace.spanId();
    const output = createAssistantMessageEventStream();
    // oxlint-disable-next-line typescript/no-floating-promises -- Pi owns the returned stream; unexpected provider exceptions remain process errors rather than being disguised as telemetry failures.
    (async () => {
      await this.record(run, {
        type: "model.started",
        spanId,
        parentSpanId: run.spanId,
        attributes: {
          "gen_ai.operation.name": "chat",
          "gen_ai.provider.name": this.llmApi.model.provider,
          "gen_ai.request.model": this.llmApi.model.id,
        },
        data: {
          context,
          model: {
            id: this.llmApi.model.id,
            provider: this.llmApi.model.provider,
            api: this.llmApi.model.api,
          },
          settings: {
            temperature: options?.temperature,
            maxTokens: options?.maxTokens,
            reasoning: options?.reasoning,
            thinkingBudgets: options?.thinkingBudgets,
            toolChoice: options?.toolChoice,
            samplingParams: options?.samplingParams,
          },
        },
      });
      const stream = this.llmApi.stream(context, {
        ...options,
        onPayload: async (payload, model) => {
          const replacement = await options?.onPayload?.(payload, model);
          const effectivePayload =
            replacement === undefined ? payload : replacement;
          await this.record(run, {
            type: "model.payload",
            spanId,
            parentSpanId: run.spanId,
            data: effectivePayload,
          });
          return replacement;
        },
      });
      for await (const event of stream) {
        if (event.type === "done" || event.type === "error") {
          const message = event.type === "done" ? event.message : event.error;
          await this.record(run, {
            type: "model.finished",
            spanId,
            parentSpanId: run.spanId,
            data: message,
          });
        }
        output.push(event);
      }
      output.end(await stream.result());
    })();
    return output;
  }
}
