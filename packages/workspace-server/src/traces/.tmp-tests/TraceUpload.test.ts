import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { expect, test as baseTest, vi } from "vitest";
import * as errore from "errore";
import { Logger, type LoggerEntry } from "@get-halo/logger";
import { traceUploadLimits } from "@get-halo/client";
import { ControlPlaneTraceUploader } from "../ControlPlaneTraceUploader.js";
import { TraceService, TraceUploadRejectedError } from "../TraceService.js";

const workspaceId = "00000000-0000-4000-8000-000000000000";
const key = (session: string) =>
  `v1/workspaces/${workspaceId}/sessions/${session}/${"a".repeat(32)}.jsonl.gz`;

type Host = {
  origin: string;
  statuses: Record<string, number[]>;
  requests: {
    url: string;
    bytes: number;
    body: Buffer;
    authorization: string | undefined;
  }[];
};

const test = baseTest.extend<{ directory: string; host: Host }>({
  directory: async ({ task }, use) => {
    const directory = path.resolve(
      import.meta.dirname,
      "../../../../../tmp/billing-investigation/tests",
      task.id,
    );
    await fs.mkdir(directory, { recursive: true });
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(
      async () => await fs.rm(directory, { recursive: true, force: true }),
    );
    await use(directory);
  },
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixtures require destructured parameters.
  host: async ({}, use) => {
    const statuses: Record<string, number[]> = {};
    const requests: Host["requests"] = [];
    const server = http.createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      requests.push({
        url: request.url ?? "",
        bytes: body.length,
        body,
        authorization: request.headers.authorization,
      });
      response
        .writeHead(statuses[request.url?.split("/")[3] ?? ""]?.shift() ?? 204)
        .end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("Missing test listener");
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) =>
          error === undefined ? resolve() : reject(error),
        ),
      );
    });
    await use({
      origin: `http://127.0.0.1:${address.port}`,
      statuses,
      requests,
    });
  },
});

test("sends a valid gzip archive with its original bytes and runtime authorization", async ({
  directory,
  host,
}) => {
  const body = gzipSync("a completed run\n");
  const filePath = path.join(directory, "run.gz");
  await fs.writeFile(filePath, body);
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test-runtime-token",
  });
  expect(
    await uploader.upload({ key: key("valid"), filePath }),
  ).toBeUndefined();
  expect(host.requests).toHaveLength(1);
  expect(host.requests[0]).toMatchObject({
    body,
    bytes: body.length,
    authorization: "Bearer test-runtime-token",
  });
});

test("rejects oversized compressed data without making a network request", async ({
  directory,
  host,
}) => {
  const filePath = path.join(directory, "too-large.gz");
  await fs.writeFile(filePath, "");
  await fs.truncate(filePath, traceUploadLimits.compressedBytes + 1);
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  expect(await uploader.upload({ key: key("large"), filePath })).toBeInstanceOf(
    TraceUploadRejectedError,
  );
  expect(host.requests).toHaveLength(0);
});

test("rejects highly compressible data over the expanded limit before sending", async ({
  directory,
  host,
}) => {
  const filePath = path.join(directory, "expanded.gz");
  await fs.writeFile(
    filePath,
    gzipSync(Buffer.alloc(traceUploadLimits.expandedBytes + 1)),
  );
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  expect(
    await uploader.upload({ key: key("expanded"), filePath }),
  ).toBeInstanceOf(TraceUploadRejectedError);
  expect(host.requests).toHaveLength(0);
});

test("accepts the inclusive compressed and expanded size limits", async ({
  directory,
  host,
}) => {
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  const compressed = gzipSync("valid\n");
  const compressedPath = path.join(directory, "compressed-limit.gz");
  await fs.writeFile(
    compressedPath,
    Buffer.concat([
      compressed,
      Buffer.alloc(traceUploadLimits.compressedBytes - compressed.length),
    ]),
  );
  expect(
    await uploader.upload({
      key: key("compressed-limit"),
      filePath: compressedPath,
    }),
  ).toBeUndefined();
  const expandedPath = path.join(directory, "expanded-limit.gz");
  await fs.writeFile(
    expandedPath,
    gzipSync(Buffer.alloc(traceUploadLimits.expandedBytes)),
  );
  expect(
    await uploader.upload({
      key: key("expanded-limit"),
      filePath: expandedPath,
    }),
  ).toBeUndefined();
  expect(host.requests).toHaveLength(2);
});

test("rejects malformed archives and keys locally but keeps file I/O errors retryable", async ({
  directory,
  host,
}) => {
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  const filePath = path.join(directory, "invalid.gz");
  await fs.writeFile(filePath, "not gzip");
  expect(
    await uploader.upload({ key: key("invalid"), filePath }),
  ).toBeInstanceOf(TraceUploadRejectedError);
  expect(await uploader.upload({ key: "bad-key", filePath })).toBeInstanceOf(
    TraceUploadRejectedError,
  );
  const missing = await uploader.upload({
    key: key("missing"),
    filePath: path.join(directory, "missing.gz"),
  });
  expect(missing).toBeInstanceOf(Error);
  expect(missing).not.toBeInstanceOf(TraceUploadRejectedError);
  const unreadable = await uploader.upload({
    key: key("directory"),
    filePath: directory,
  });
  expect(unreadable).toBeInstanceOf(Error);
  expect(unreadable).not.toBeInstanceOf(TraceUploadRejectedError);
  expect(host.requests).toHaveLength(0);
});

for (const status of [400, 413, 415, 422]) {
  test(`marks HTTP ${status} as permanently rejected`, async ({
    directory,
    host,
  }) => {
    const filePath = path.join(directory, "run.gz");
    await fs.writeFile(filePath, gzipSync("run\n"));
    host.statuses.rejected = [status];
    const uploader = new ControlPlaneTraceUploader({
      origin: host.origin,
      token: "test",
    });
    expect(
      await uploader.upload({ key: key("rejected"), filePath }),
    ).toBeInstanceOf(TraceUploadRejectedError);
  });
}

for (const status of [401, 403, 408, 429, 500, 503]) {
  test(`keeps HTTP ${status} retryable`, async ({ directory, host }) => {
    const filePath = path.join(directory, "run.gz");
    await fs.writeFile(filePath, gzipSync("run\n"));
    host.statuses.retry = [status];
    const uploader = new ControlPlaneTraceUploader({
      origin: host.origin,
      token: "test",
    });
    const uploaded = await uploader.upload({ key: key("retry"), filePath });
    expect(uploaded).toBeInstanceOf(Error);
    expect(uploaded).not.toBeInstanceOf(TraceUploadRejectedError);
  });
}

test("quarantines permanent rejections once, continues valid uploads, and does not retry them after restart", async ({
  directory,
  host,
}) => {
  const logger = new Logger();
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  const rejectedKey = key("a-rejected");
  const validKey = key("b-valid");
  const body = gzipSync("completed\n");
  for (const archiveKey of [rejectedKey, validKey]) {
    const filePath = path.join(directory, "pending", archiveKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, body);
  }
  host.statuses["a-rejected"] = [400];
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger,
    uploader,
  });
  if (service instanceof Error) throw service;
  await expect
    .poll(
      async () =>
        await fs.readFile(path.join(directory, "rejected", rejectedKey)),
    )
    .toEqual(body);
  await expect
    .poll(
      async () => await fs.readFile(path.join(directory, "archive", validKey)),
    )
    .toEqual(body);
  await service.close();
  expect(host.requests).toHaveLength(2);
  const restarted = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger,
    uploader,
  });
  if (restarted instanceof Error) throw restarted;
  await restarted.close();
  expect(host.requests).toHaveLength(2);
  expect(
    await fs.readFile(path.join(directory, "rejected", rejectedKey)),
  ).toEqual(body);
});

test("backs off transient failures while later archives upload, then resets after success", async ({
  directory,
  host,
}) => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  using cleanup = new errore.DisposableStack();
  cleanup.defer(() => vi.useRealTimers());
  const entries: LoggerEntry[] = [];
  const logger = new Logger({
    sinks: [{ log: (entry) => entries.push(entry) }],
  });
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  const retryKey = key("a-retry");
  const validKey = key("b-valid");
  for (const archiveKey of [retryKey, validKey]) {
    const filePath = path.join(directory, "pending", archiveKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, gzipSync("completed\n"));
  }
  host.statuses["a-retry"] = [503, 503, 204];
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger,
    uploader,
  });
  if (service instanceof Error) throw service;
  await using serviceCleanup = new errore.AsyncDisposableStack();
  serviceCleanup.defer(async () => await service.close());
  await expect.poll(() => host.requests.length).toBe(2);
  await expect
    .poll(async () => await fs.stat(path.join(directory, "archive", validKey)))
    .toBeDefined();
  await vi.advanceTimersByTimeAsync(30_000);
  await expect.poll(() => entries.length).toBe(2);
  expect(host.requests).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(30_000);
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(host.requests).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(30_000);
  await expect
    .poll(async () => await fs.stat(path.join(directory, "archive", retryKey)))
    .toBeDefined();
  expect(host.requests).toHaveLength(4);
});

test("uploads runs completed during an in-flight pass immediately and coalesces timer notifications", async ({
  directory,
}) => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  using timers = new errore.DisposableStack();
  timers.defer(() => vi.useRealTimers());
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const uploads: string[] = [];
  const firstKey = key("first");
  const first = path.join(directory, "pending", firstKey);
  await fs.mkdir(path.dirname(first), { recursive: true });
  await fs.writeFile(first, gzipSync("completed\n"));
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger(),
    uploader: {
      async upload({ key: archiveKey }) {
        uploads.push(archiveKey);
        if (archiveKey === firstKey) await blocked;
      },
    },
  });
  if (service instanceof Error) throw service;
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    release();
    await service.close();
  });
  await expect.poll(() => uploads.length).toBe(1);
  const run = await service.start({
    sessionId: "during-upload",
    agent: { id: "custom" },
  });
  if (run instanceof Error) throw run;
  expect(await service.finish(run.traceId, "completed")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(uploads).toHaveLength(1);
  release();
  await expect.poll(() => uploads.length).toBe(2);
  await expect
    .poll(
      async () =>
        await fs.readdir(
          path.join(
            directory,
            "archive",
            `v1/workspaces/${workspaceId}/sessions/during-upload`,
          ),
        ),
    )
    .toEqual([`${run.traceId}.jsonl.gz`]);
  expect(uploads).toHaveLength(2);
});
