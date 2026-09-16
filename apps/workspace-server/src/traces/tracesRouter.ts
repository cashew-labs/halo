import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { TraceService } from "./TraceService.js";

export type TracesRouterContext = { traces: TraceService };

const os = implement(contract.traces).$context<TracesRouterContext>();

export const tracesRouter = os.router({
  start: os.start.handler(async ({ input, context }) => {
    const run = await context.traces.start(input);
    if (run instanceof Error) return orpcErrors.badRequest(run);
    return { traceId: run.traceId, spanId: run.spanId };
  }),
  record: os.record.handler(async ({ input, context }) => {
    const run = context.traces.get(input.traceId);
    if (run instanceof Error) return orpcErrors.badRequest(run);
    const recorded = await run.record(input.event);
    if (recorded instanceof Error) return orpcErrors.badRequest(recorded);
  }),
  finish: os.finish.handler(async ({ input, context }) => {
    const finished = await context.traces.finish(input.traceId, input.outcome);
    if (finished instanceof Error) return orpcErrors.badRequest(finished);
  }),
});
