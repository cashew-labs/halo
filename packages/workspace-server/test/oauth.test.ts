import type { HaloConnectionEvent } from "@get-halo/client";
import { expect, test as baseTest, vi } from "vitest";
import {
  ConnectionService,
  ConnectionUnavailableError,
  type RemoteConnectionBackend,
} from "../src/agent/runtime/ConnectionService.js";

type SetupDriver = {
  events: HaloConnectionEvent[];
  status: Awaited<ReturnType<RemoteConnectionBackend["setup"]>>;
  cancellationError: Error | undefined;
  cancellations: number;
};

const test = baseTest.extend<{
  setup: SetupDriver & { connections: ConnectionService };
}>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixtures require destructured parameters.
  setup: async ({}, use) => {
    vi.useFakeTimers();
    const state: SetupDriver = {
      status: { status: "authorizing" },
      cancellationError: undefined,
      cancellations: 0,
      events: [],
    };
    const connections = new ConnectionService({
      remote: {
        catalog: async () => [],
        startSetup: async () => ({
          setupId: "setup",
          setupUrl: "https://halo.example/integrations/setup/setup",
        }),
        setup: async () => state.status,
        cancelSetup: async () => {
          state.cancellations++;
          if (state.cancellationError !== undefined)
            return state.cancellationError;
          if (
            !(state.status instanceof Error) &&
            state.status.status === "authorizing"
          )
            state.status = { status: "cancelled" };
          return state.cancellationError;
        },
      },
    });
    await use(Object.assign(state, { connections }));
    connections.close();
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
  },
});

const request = { kind: "control-plane" as const, integration: "example" };

test("remote setup publishes ready once and enforces cancellation ownership", async ({
  setup,
}) => {
  setup.cancellationError = new Error("Setup is completing");
  const started = await setup.connections.startConnection({
    sessionId: "owner",
    request,
    onEvent: async (event) => {
      setup.events.push(event);
    },
  });
  expect(started).toMatchObject({
    status: "authorization-required",
    authorizationUrl: "https://halo.example/integrations/setup/setup",
  });
  if (started instanceof Error || started.status !== "authorization-required")
    throw new Error("Setup did not start");
  expect(
    await setup.connections.cancelConnection({
      sessionId: "other",
      connectionId: started.connectionId,
    }),
  ).toBeInstanceOf(Error);
  expect(setup.cancellations).toBe(0);
  expect(
    await setup.connections.cancelConnection({
      sessionId: "owner",
      connectionId: started.connectionId,
    }),
  ).toBeInstanceOf(Error);
  expect(setup.cancellations).toBe(1);
  expect(setup.events.map((event) => event.status)).toEqual(["connecting"]);
  await vi.advanceTimersByTimeAsync(1_000);
  setup.status = { status: "ready" };
  await vi.advanceTimersByTimeAsync(2_000);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(setup.events.map((event) => event.status)).toEqual([
    "connecting",
    "connected",
  ]);
});

test.for(["cancelled", "expired", "failed"] as const)(
  "remote %s setup terminates polling",
  async (status, { setup }) => {
    setup.status = { status };
    await setup.connections.startConnection({
      sessionId: "owner",
      request,
      onEvent: async () => undefined,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(setup.connections.statesForSession("owner")).toMatchObject([
      { status },
    ]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test.for(["authorizing", "ready"] as const)(
  "cancellation preserves remote %s outcome and stops polling",
  async (status, { setup }) => {
    setup.status = { status };
    const started = await setup.connections.startConnection({
      sessionId: "owner",
      request,
      onEvent: async (event) => {
        setup.events.push(event);
      },
    });
    if (started instanceof Error || started.status !== "authorization-required")
      throw new Error("Setup did not start");
    expect(
      await setup.connections.cancelConnection({
        sessionId: "owner",
        connectionId: started.connectionId,
      }),
    ).toBeUndefined();
    await setup.connections.cancelConnection({
      sessionId: "owner",
      connectionId: started.connectionId,
    });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(setup.cancellations).toBe(1);
    expect(setup.events.map((event) => event.status)).toEqual([
      "connecting",
      status === "ready" ? "connected" : "cancelled",
    ]);
    expect(vi.getTimerCount()).toBe(0);
  },
);

test("authorizing setup expires at the advertised deadline", async ({
  setup,
}) => {
  const started = await setup.connections.startConnection({
    sessionId: "owner",
    request,
    onEvent: async (event) => {
      setup.events.push(event);
    },
  });
  if (started instanceof Error || started.status !== "authorization-required")
    throw new Error("Setup did not start");
  await vi.advanceTimersByTimeAsync(started.expiresAt - Date.now() + 2_000);
  expect(setup.events.map((event) => event.status)).toEqual([
    "connecting",
    "expired",
  ]);
  expect(vi.getTimerCount()).toBe(0);
});

test("missing remote host returns an explicit setup error", async () => {
  const connections = new ConnectionService({});
  expect(
    await connections.startConnection({
      sessionId: "owner",
      request,
      onEvent: async () => undefined,
    }),
  ).toBeInstanceOf(ConnectionUnavailableError);
  connections.close();
});
