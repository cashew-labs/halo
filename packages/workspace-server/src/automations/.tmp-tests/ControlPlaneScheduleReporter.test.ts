import { expect } from "vitest";
import { serverTest } from "../../../test/serverTest.js";
import { ControlPlaneScheduleReporter } from "../ControlPlaneScheduleReporter.js";

serverTest(
  "publishes automation schedule snapshots with scoped authentication",
  async ({ http }) => {
    const reporter = new ControlPlaneScheduleReporter({
      origin: http.url(""),
      token: "schedule-test-token",
    });
    const snapshot = {
      automations: [{ id: "daily", nextRunAt: "2026-10-10T09:00:00.000Z" }],
    };
    const pending = reporter.report(snapshot, new AbortController().signal);
    const request = await http.request(
      "/api/workspace-runtime/automations/schedules",
    );
    expect(request.headers.authorization).toBe("Bearer schedule-test-token");
    expect(JSON.parse((await request.body()).toString())).toEqual(snapshot);
    request.respond("", { status: 204 });
    expect(await pending).toBeUndefined();

    const rejected = reporter.report(
      { automations: [] },
      new AbortController().signal,
    );
    const second = await http.request(
      "/api/workspace-runtime/automations/schedules",
    );
    second.respond("", { status: 401 });
    expect(await rejected).toMatchObject({
      name: "AutomationReportError",
      message: expect.stringContaining("HTTP 401"),
    });

    const cancelled = new AbortController();
    cancelled.abort();
    expect(await reporter.report(snapshot, cancelled.signal)).toMatchObject({
      name: "AutomationReportError",
      message: expect.stringContaining("send snapshot"),
    });
  },
);
