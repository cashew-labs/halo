import { expect, test } from "vitest";
import type { DeviceAdvertisement, DeviceRequest } from "@get-halo/client";
import {
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

/** Opens a device stream and collects the requests it receives. */
function connect(devices: DeviceService) {
  const closed = new AbortController();
  const received: DeviceRequest[] = [];
  const served = (async () => {
    for await (const request of devices.serve({
      device: laptop,
      signal: closed.signal,
    }))
      received.push(request);
  })();
  return {
    received,
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

test("a call times out when the device never answers", async () => {
  const devices = new DeviceService();
  const device = connect(devices);
  expect(
    await devices.call({ device: "Laptop", operation: stat, timeoutMs: 20 }),
  ).toBeInstanceOf(DeviceTimeoutError);
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
