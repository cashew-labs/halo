import { describe, expect, test } from "vitest";
import {
  connectionStateAfterCancel,
  connectionStateAfterFailedStart,
  connectionStateForCard,
  idleConnectionState,
  type ConnectionState,
} from "../src/main/agent/ConnectionState.ts";

const connecting: ConnectionState = {
  status: "connecting",
  connectionId: "c1",
  expiresAt: 1,
  wasConnected: false,
};

describe("connectionStateForCard", () => {
  test("every card shows an attempt in progress", () => {
    expect(connectionStateForCard(connecting, "card-a", "card-b")).toBe(
      connecting,
    );
    const starting: ConnectionState = {
      status: "starting",
      wasConnected: false,
    };
    expect(connectionStateForCard(starting, "card-a", "card-b")).toBe(starting);
    expect(connectionStateForCard(idleConnectionState, "card-a", "card-b")).toBe(
      idleConnectionState,
    );
  });

  test("a finished attempt stays on the card that started it", () => {
    for (const status of [
      "connected",
      "expired",
      "failed",
      "cancelled",
    ] as const) {
      const state: ConnectionState = { status };
      expect(connectionStateForCard(state, "card-a", "card-a")).toBe(state);
      expect(connectionStateForCard(state, "card-a", "card-b")).toEqual(
        idleConnectionState,
      );
    }
  });

  test("every card shows a finished attempt with an unknown starting card", () => {
    const state: ConnectionState = { status: "expired" };
    expect(connectionStateForCard(state, undefined, "card-b")).toBe(state);
  });
});

describe("mutation transitions", () => {
  test("a failed start keeps an existing connection", () => {
    expect(
      connectionStateAfterFailedStart({ status: "starting", wasConnected: true }),
    ).toEqual({ status: "connected" });
    expect(
      connectionStateAfterFailedStart({ ...connecting, wasConnected: true }),
    ).toEqual({ status: "connected" });
    expect(connectionStateAfterFailedStart(connecting)).toEqual(
      idleConnectionState,
    );
    expect(connectionStateAfterFailedStart(undefined)).toEqual(
      idleConnectionState,
    );
  });

  test("cancelling keeps an existing connection", () => {
    expect(
      connectionStateAfterCancel({ ...connecting, wasConnected: true }),
    ).toEqual({ status: "connected" });
    expect(connectionStateAfterCancel(connecting)).toEqual({
      status: "cancelled",
    });
    const expired: ConnectionState = { status: "expired" };
    expect(connectionStateAfterCancel(expired)).toBe(expired);
  });
});
