import { expect, test } from "vitest";
import type { DeviceAdvertisement, DeviceRequest } from "@get-halo/client";
import {
  DeviceCallAbortedError,
  DeviceCallNotFoundError,
  DeviceDisconnectedError,
  DeviceService,
  DeviceTimeoutError,
} from "./DeviceService.js";

const laptop: DeviceAdvertisement = {
  id: "laptop-id",
  name: "Laptop",
  platform: "darwin",
  home: "/Users/sam",
};
const stat = { type: "files.stat", path: "/Users/sam/Documents" } as const;
const documents = {
  name: "Documents",
  path: "/Users/sam/Documents",
  type: "directory",
  size: 0,
  modifiedAt: 0,
} as const;

type RunRequest = Extract<DeviceRequest, { operation: unknown }>;

/** Opens a device stream and collects the requests it receives. */
function connect(devices: DeviceService) {
  const closed = new AbortController();
  const received: RunRequest[] = [];
  const cancelled: string[] = [];
  const served = (async () => {
    for await (const request of devices.serve({
      device: laptop,
      signal: closed.signal,
    }))
      if ("cancel" in request) cancelled.push(request.cancel);
      else received.push(request);
  })();
  return {
    received,
    cancelled,
    close: async () => {
      closed.abort();
      await served;
    },
  };
}

test("delivers a call to the device and returns its answer", async () => {
  const devices = new DeviceService();
  const device = connect(devices);
  const result = devices.call({ device: "laptop", operation: stat });
  await expect.poll(() => device.received).toHaveLength(1);
  const [request] = device.received;
  expect(request?.operation).toEqual(stat);
  devices.respond({
    deviceId: laptop.id,
    callId: request!.callId,
    ok: true,
    result: documents,
  });
  expect(await result).toEqual(documents);
  await device.close();
});

test("a call survives a brief reconnect and fails after a longer one", async () => {
  const devices = new DeviceService({ disconnectGraceMs: 50 });
  const first = connect(devices);
  const kept = devices.call({ device: "Laptop", operation: stat });
  await expect.poll(() => first.received).toHaveLength(1);
  await first.close();
  const second = connect(devices);
  await new Promise((resolve) => setTimeout(resolve, 100));
  devices.respond({
    deviceId: laptop.id,
    callId: first.received[0]!.callId,
    ok: true,
    result: documents,
  });
  expect(await kept).toEqual(documents);

  const lost = devices.call({ device: "Laptop", operation: stat });
  await expect.poll(() => second.received).toHaveLength(1);
  await second.close();
  expect(await lost).toBeInstanceOf(DeviceDisconnectedError);
});

test("a call times out when the device never answers, and the device is told to stop", async () => {
  const devices = new DeviceService();
  const device = connect(devices);
  expect(
    await devices.call({ device: "Laptop", operation: stat, timeoutMs: 20 }),
  ).toBeInstanceOf(DeviceTimeoutError);
  await expect
    .poll(() => device.cancelled)
    .toEqual([device.received[0]?.callId]);
  await device.close();
});

test("cancelling a call tells the device to stop it", async () => {
  const devices = new DeviceService();
  const device = connect(devices);
  const cancel = new AbortController();
  const result = devices.call({
    device: "Laptop",
    operation: { type: "shell.run", command: "sleep 30", timeoutMs: 60_000 },
    signal: cancel.signal,
  });
  await expect.poll(() => device.received).toHaveLength(1);
  cancel.abort();
  expect(await result).toBeInstanceOf(DeviceCallAbortedError);
  await expect
    .poll(() => device.cancelled)
    .toEqual([device.received[0]?.callId]);
  await device.close();
});

test("only the device that received a call can answer it", async () => {
  const devices = new DeviceService();
  const device = connect(devices);
  const result = devices.call({ device: "Laptop", operation: stat });
  await expect.poll(() => device.received).toHaveLength(1);
  expect(
    devices.respond({
      deviceId: "another-device",
      callId: device.received[0]!.callId,
      ok: true,
      result: documents,
    }),
  ).toBeInstanceOf(DeviceCallNotFoundError);
  devices.close();
  expect(await result).toBeInstanceOf(DeviceDisconnectedError);
  await device.close();
});
