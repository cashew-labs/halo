import { randomBytes } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { expect, test as baseTest, vi } from "vitest";
import * as errore from "errore";
import { Logger, type LoggerEntry } from "@get-halo/logger";
import { traceUploadLimits } from "@get-halo/client";
import { ControlPlaneTraceUploader } from "../ControlPlaneTraceUploader.js";
import { TraceService, TraceUploadRejectedError } from "../TraceService.js";
import { TraceStorageError } from "../RunTrace.js";

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

test("uploads a small report with complete beginning records for an oversized compressed archive", async ({
  directory,
  host,
}) => {
  const filePath = path.join(directory, "too-large.gz");
  const beginning =
    '{"type":"run.started"}\n{"type":"tool.started","data":"hello"}\n';
  await fs.writeFile(
    filePath,
    gzipSync(
      beginning +
        JSON.stringify({
          data: randomBytes(17 * 1024 * 1024).toString("base64"),
        }) +
        "\n",
    ),
  );
  const originalSize = (await fs.stat(filePath)).size;
  expect(originalSize).toBeGreaterThan(traceUploadLimits.compressedBytes);
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  expect(await uploader.upload({ key: key("large"), filePath })).toMatchObject({
    partial: true,
    reason: "compressed size limit exceeded",
  });
  expect(host.requests).toHaveLength(1);
  expect(host.requests[0]!.bytes).toBeLessThan(1024);
  const records = gunzipSync(host.requests[0]!.body)
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records.map((record) => record.type)).toEqual([
    "run.started",
    "archive.truncated",
    "run.finished",
  ]);
  expect(records[1].data).toMatchObject({
    reason: "compressed size limit exceeded",
    compressedBytes: originalSize,
    preview: beginning,
    previewReadFailed: false,
  });
  expect(records[2].data).toEqual({
    kind: "archive-upload-report",
    fullArchiveUploaded: false,
  });
  expect((await fs.stat(filePath)).size).toBe(originalSize);
});

test("bounds the expanded preview and excludes the incomplete next record", async ({
  directory,
  host,
}) => {
  const filePath = path.join(directory, "expanded.gz");
  const beginning = '{"type":"run.started"}\n';
  await fs.writeFile(
    filePath,
    gzipSync(
      beginning +
        '{"data":"' +
        "x".repeat(traceUploadLimits.expandedBytes) +
        '"}\n',
    ),
  );
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  expect(
    await uploader.upload({ key: key("expanded"), filePath }),
  ).toMatchObject({ partial: true, reason: "expanded size limit exceeded" });
  expect(host.requests).toHaveLength(1);
  const records = gunzipSync(host.requests[0]!.body)
    .toString()
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records[1].data.preview).toBe(beginning);
  expect(records[1].data.previewLimitBytes).toBe(65536);
  expect(host.requests[0]!.bytes).toBeLessThan(1024);
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

test("retries a transient failure once while later archives upload", async ({
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
  host.statuses["a-retry"] = [503, 204];
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
  await expect
    .poll(async () => await fs.stat(path.join(directory, "archive", retryKey)))
    .toBeDefined();
  expect(host.requests).toHaveLength(3);
  expect(
    await fs.readFile(
      path.join(directory, "archive", `${retryKey}.attempts`),
      "utf8",
    ),
  ).toBe("2");
  await vi.advanceTimersByTimeAsync(120_000);
  expect(host.requests).toHaveLength(3);
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
    .poll(async () =>
      (
        await fs.readdir(
          path.join(
            directory,
            "archive",
            `v1/workspaces/${workspaceId}/sessions/during-upload`,
          ),
        )
      ).filter((name) => name.endsWith(".jsonl.gz")),
    )
    .toEqual([`${run.traceId}.jsonl.gz`]);
  expect(uploads).toHaveLength(2);
});

test("allows only two attempts across restarts and preserves exhausted archives outside pending", async ({
  directory,
  host,
}) => {
  const archiveKey = key("exhausted");
  const filePath = path.join(directory, "pending", archiveKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const body = gzipSync("completed\n");
  await fs.writeFile(filePath, body);
  host.statuses.exhausted = [503, 503, 204];
  const uploader = new ControlPlaneTraceUploader({
    origin: host.origin,
    token: "test",
  });
  const options = {
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger(),
    uploader,
  };
  const first = await TraceService.open(options);
  if (first instanceof Error) throw first;
  await expect
    .poll(async () => await fs.readFile(`${filePath}.attempts`, "utf8"))
    .toBe("1");
  await expect.poll(() => host.requests.length).toBe(1);
  await first.close();
  const second = await TraceService.open(options);
  if (second instanceof Error) throw second;
  await expect
    .poll(
      async () => await fs.readFile(path.join(directory, "failed", archiveKey)),
    )
    .toEqual(body);
  await second.close();
  expect(host.requests).toHaveLength(2);
  expect(
    await fs.readFile(
      path.join(directory, "failed", `${archiveKey}.attempts`),
      "utf8",
    ),
  ).toBe("2");
  const third = await TraceService.open(options);
  if (third instanceof Error) throw third;
  await third.close();
  expect(host.requests).toHaveLength(2);
});

test("does not resend an archive whose second attempt was recorded before a crash", async ({
  directory,
  host,
}) => {
  const archiveKey = key("crash");
  const filePath = path.join(directory, "pending", archiveKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, gzipSync("completed\n"));
  await fs.writeFile(`${filePath}.attempts`, "2");
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger(),
    uploader: new ControlPlaneTraceUploader({
      origin: host.origin,
      token: "test",
    }),
  });
  if (service instanceof Error) throw service;
  await expect
    .poll(async () => await fs.stat(path.join(directory, "failed", archiveKey)))
    .toBeDefined();
  await service.close();
  expect(host.requests).toHaveLength(0);
});

test("keeps a full oversized archive locally after its preview report succeeds", async ({
  directory,
  host,
}) => {
  const archiveKey = key("preview");
  const filePath = path.join(directory, "pending", archiveKey);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, gzipSync('{"type":"run.started"}\n'));
  await fs.truncate(filePath, traceUploadLimits.compressedBytes + 1);
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger(),
    uploader: new ControlPlaneTraceUploader({
      origin: host.origin,
      token: "test",
    }),
  });
  if (service instanceof Error) throw service;
  await expect
    .poll(
      async () =>
        (await fs.stat(path.join(directory, "rejected", archiveKey))).size,
    )
    .toBe(traceUploadLimits.compressedBytes + 1);
  await service.close();
  expect(host.requests).toHaveLength(1);
  const restarted = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger(),
    uploader: new ControlPlaneTraceUploader({
      origin: host.origin,
      token: "test",
    }),
  });
  if (restarted instanceof Error) throw restarted;
  await restarted.close();
  expect(host.requests).toHaveLength(1);
});

test("an unconfigured service retains completed traces locally without scheduling uploads", async ({
  directory,
  host,
}) => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  using timers = new errore.DisposableStack();
  timers.defer(() => vi.useRealTimers());
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger(),
  });
  if (service instanceof Error) throw service;
  const run = await service.start({
    sessionId: "local",
    agent: { id: "custom" },
  });
  if (run instanceof Error) throw run;
  expect(await service.finish(run.traceId, "completed")).toBeUndefined();
  await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
  const filePath = path.join(
    directory,
    "pending",
    `v1/workspaces/${workspaceId}/sessions/local/${run.traceId}.jsonl.gz`,
  );
  expect(gunzipSync(await fs.readFile(filePath)).toString()).toContain(
    '"type":"run.finished"',
  );
  expect(host.requests).toHaveLength(0);
  expect(
    await fs.stat(`${filePath}.attempts`).catch(() => undefined),
  ).toBeUndefined();
  await service.close();
});

test("corrupt or unreadable attempt counters do not reset the budget or block other archives", async ({
  directory,
  host,
}) => {
  const badKey = key("a-counter");
  const ioKey = key("b-unreadable");
  const goodKey = key("c-good");
  for (const archiveKey of [badKey, ioKey, goodKey]) {
    const filePath = path.join(directory, "pending", archiveKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, gzipSync("completed\n"));
  }
  await fs.writeFile(
    path.join(directory, "pending", `${badKey}.attempts`),
    "broken",
  );
  await fs.mkdir(path.join(directory, "pending", `${ioKey}.attempts`));
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger(),
    uploader: new ControlPlaneTraceUploader({
      origin: host.origin,
      token: "test",
    }),
  });
  if (service instanceof Error) throw service;
  await expect
    .poll(async () => await fs.stat(path.join(directory, "archive", goodKey)))
    .toBeDefined();
  await service.close();
  expect(host.requests).toHaveLength(1);
  expect(host.requests[0]!.url).toContain("/c-good/");
});

test("does not send an unrecorded attempt when its directory is read-only, and continues later files", async ({
  directory,
  host,
}) => {
  const blockedKey = key("a-read-only");
  const goodKey = key("b-writable");
  const blockedPath = path.join(directory, "pending", blockedKey);
  for (const archiveKey of [blockedKey, goodKey]) {
    const filePath = path.join(directory, "pending", archiveKey);
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, gzipSync("completed\n"));
  }
  const entries: LoggerEntry[] = [];
  await fs.chmod(path.dirname(blockedPath), 0o500);
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => await fs.chmod(path.dirname(blockedPath), 0o700));
  const service = await TraceService.open({
    directory,
    workspaceId,
    appVersion: "test",
    logger: new Logger({ sinks: [{ log: (entry) => entries.push(entry) }] }),
    uploader: new ControlPlaneTraceUploader({
      origin: host.origin,
      token: "test",
    }),
  });
  if (service instanceof Error) throw service;
  cleanup.defer(async () => await service.close());
  await expect
    .poll(async () => await fs.stat(path.join(directory, "archive", goodKey)))
    .toBeDefined();
  expect(host.requests).toHaveLength(1);
  expect(host.requests[0]!.url).toContain("/b-writable/");
  expect(
    entries.some((entry) => entry.data.event === "trace-storage-failed"),
  ).toBe(true);
  expect(
    entries.some(
      (entry) =>
        entry.data.error instanceof TraceStorageError &&
        entry.data.error.operation === "record upload attempt",
    ),
  ).toBe(true);
  expect(await fs.readFile(blockedPath)).toEqual(gzipSync("completed\n"));
});

for (const failure of ["mkdir", "archive-rename", "counter-rename"] as const) {
  test(`reports ${failure} failure and continues later archives without losing the original`, async ({
    directory,
    host,
  }) => {
    const badKey = key("a-fs-failure");
    const goodKey = key("b-good");
    const body = gzipSync("completed\n");
    for (const archiveKey of [badKey, goodKey]) {
      const filePath = path.join(directory, "pending", archiveKey);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, body);
    }
    const destination = path.join(directory, "rejected", badKey);
    if (failure === "mkdir")
      await fs.writeFile(
        path.join(directory, "rejected"),
        "blocks destination",
      );
    else {
      const blocked =
        failure === "archive-rename" ? destination : `${destination}.attempts`;
      await fs.mkdir(blocked, { recursive: true });
      await fs.writeFile(path.join(blocked, "keep"), "non-empty directory");
    }
    host.statuses["a-fs-failure"] = [400];
    const entries: LoggerEntry[] = [];
    const service = await TraceService.open({
      directory,
      workspaceId,
      appVersion: "test",
      logger: new Logger({ sinks: [{ log: (entry) => entries.push(entry) }] }),
      uploader: new ControlPlaneTraceUploader({
        origin: host.origin,
        token: "test",
      }),
    });
    if (service instanceof Error) throw service;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => await service.close());
    await expect
      .poll(async () => await fs.stat(path.join(directory, "archive", goodKey)))
      .toBeDefined();
    expect(host.requests).toHaveLength(2);
    expect(
      entries.filter((entry) => entry.data.event === "trace-storage-failed")
        .length,
    ).toBeGreaterThanOrEqual(2);
    const operation =
      failure === "mkdir"
        ? "create upload destination"
        : failure === "archive-rename"
          ? "settle upload"
          : "preserve upload attempt count";
    expect(
      entries.some(
        (entry) =>
          entry.data.error instanceof TraceStorageError &&
          entry.data.error.operation === operation,
      ),
    ).toBe(true);
    const retained =
      failure === "counter-rename"
        ? destination
        : path.join(directory, "pending", badKey);
    expect(await fs.readFile(retained)).toEqual(body);
    expect(
      await fs.readFile(
        path.join(directory, "pending", `${badKey}.attempts`),
        "utf8",
      ),
    ).toBe("1");
  });
}
