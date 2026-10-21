import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { createHaloClient, uploadChatFile } from "@get-halo/client";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { serverTest } from "../serverTest.js";

type FsMethod = "mkdir" | "writeFile" | "open" | "rename" | "rm" | "readFile";

/** Fails one `fs/promises` method for paths the predicate selects. */
function failFs(method: FsMethod, matches: (target: string) => boolean) {
  const original = fs[method].bind(fs) as (...args: unknown[]) => unknown;
  return vi
    .spyOn(fs, method)
    .mockImplementation((async (...args: unknown[]) => {
      if (matches(String(args[0])))
        throw Object.assign(new Error(`injected ${method} failure`), {
          code: "EIO",
        });
      return await original(...args);
    }) as never);
}

async function upload(
  api: Parameters<typeof uploadChatFile>[0]["api"],
  name: string,
  text: string,
) {
  const uploaded = await uploadChatFile({ api, file: new File([text], name) });
  if (uploaded instanceof Error) throw uploaded;
  return uploaded.uploadId;
}

serverTest("reports storage failures while creating uploads", async ({ server }) => {
  const staging = path.join(server.workspaceRoot, ".halo", "uploads");
  const statfs = vi
    .spyOn(fs, "statfs")
    .mockRejectedValue(new Error("injected statfs failure"));
  await expect(
    server.rpc.uploads.create({ name: "a.txt", size: 1, mimeType: "" }),
  ).rejects.toThrow("Could not store a.txt in the workspace.");
  statfs.mockRestore();
  const mkdir = failFs("mkdir", (target) => target.startsWith(staging));
  await expect(
    server.rpc.uploads.create({ name: "b.txt", size: 1, mimeType: "" }),
  ).rejects.toThrow("Could not store b.txt in the workspace.");
  mkdir.mockRestore();
  const writeFile = failFs("writeFile", (target) => target.startsWith(staging));
  await expect(
    server.rpc.uploads.create({ name: "c.txt", size: 1, mimeType: "" }),
  ).rejects.toThrow("Could not store c.txt in the workspace.");
  writeFile.mockRestore();
});

serverTest("reports storage failures while writing chunks", async ({ server }) => {
  const staging = path.join(server.workspaceRoot, ".halo", "uploads");
  const { uploadId } = await server.rpc.uploads.create({
    name: "chunk.txt",
    size: 5,
    mimeType: "",
  });
  const open = failFs("open", (target) => target.startsWith(staging));
  await expect(
    server.rpc.uploads.write({ uploadId, offset: 0, chunk: new Blob(["hello"]) }),
  ).rejects.toThrow("Could not store chunk.txt in the workspace.");
  open.mockRestore();
  const realOpen = fs.open.bind(fs);
  const failingWrite = vi.spyOn(fs, "open").mockImplementation((async (
    ...args: Parameters<typeof fs.open>
  ) => {
    const handle = await realOpen(...args);
    if (!String(args[0]).startsWith(staging)) return handle;
    handle.write = (async () => {
      throw new Error("injected write failure");
    }) as never;
    return handle;
  }) as never);
  await expect(
    server.rpc.uploads.write({ uploadId, offset: 0, chunk: new Blob(["hello"]) }),
  ).rejects.toThrow("Could not store chunk.txt in the workspace.");
  failingWrite.mockRestore();
  expect(await server.rpc.uploads.status({ uploadId })).toEqual({
    received: 0,
    size: 5,
  });
  expect(
    await server.rpc.uploads.write({
      uploadId,
      offset: 0,
      chunk: new Blob(["hello"]),
    }),
  ).toEqual({ received: 5 });
});

serverTest(
  "limits claims to 10 files and restores earlier files when a later move fails",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const many = await Promise.all(
      Array.from({ length: 11 }, async (_, index) =>
        await upload(server.rpc, `file-${index}.txt`, "x"),
      ),
    );
    await expect(
      server.rpc.thread.prompt({
        sessionId: session.sessionId,
        text: "Too many",
        uploadIds: many,
      }),
    ).rejects.toThrow("Attach up to 10 files per message.");
    const first = await upload(server.rpc, "first.txt", "scarlet robin");
    const second = await upload(server.rpc, "second.txt", "orange heron");
    // A non-empty directory at the second file's destination blocks its move.
    await fs.mkdir(
      path.join(server.workspaceRoot, "attachments", second, "second.txt"),
      { recursive: true },
    );
    await fs.writeFile(
      path.join(
        server.workspaceRoot,
        "attachments",
        second,
        "second.txt",
        "blocker",
      ),
      "",
    );
    await expect(
      server.rpc.thread.prompt({
        sessionId: session.sessionId,
        text: "Both",
        uploadIds: [first, second],
      }),
    ).rejects.toThrow("Could not store second.txt in the workspace.");
    expect(await server.rpc.uploads.status({ uploadId: first })).toEqual({
      received: 13,
      size: 13,
    });
    await expect(
      fs.access(path.join(server.workspaceRoot, "attachments", first)),
    ).rejects.toThrow();
    await server.rpc.thread.prompt({
      sessionId: session.sessionId,
      text: "Only the first",
      uploadIds: [first],
    });
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("scarlet robin");
      return m.assistant("Read it.");
    });
  },
);

serverTest(
  "reports claim directory failures and tolerates staging cleanup failures",
  async ({ server, llm }) => {
    const attachments = path.join(server.workspaceRoot, "attachments");
    const staging = path.join(server.workspaceRoot, ".halo", "uploads");
    const session = await server.rpc.thread.new();
    const blocked = await upload(server.rpc, "blocked.txt", "blocked");
    const mkdir = failFs("mkdir", (target) => target.startsWith(attachments));
    await expect(
      server.rpc.thread.prompt({
        sessionId: session.sessionId,
        text: "Blocked",
        uploadIds: [blocked],
      }),
    ).rejects.toThrow("Could not store blocked.txt in the workspace.");
    mkdir.mockRestore();
    const warn = vi.spyOn(console, "warn");
    const rm = failFs("rm", (target) => target.startsWith(staging));
    await server.rpc.thread.prompt({
      sessionId: session.sessionId,
      text: "Sent anyway",
      uploadIds: [blocked],
    });
    rm.mockRestore();
    expect(warn).toHaveBeenCalledWith(
      "Could not remove claimed upload staging:",
      expect.anything(),
    );
    warn.mockRestore();
    await llm.respond(m.assistant("Done."));
  },
);

serverTest(
  "logs release failures when a rejected message cannot return its uploads",
  async ({ server }) => {
    const attachments = path.join(server.workspaceRoot, "attachments");
    const staging = path.join(server.workspaceRoot, ".halo", "uploads");
    const warn = vi.spyOn(console, "warn");
    const reject = async (uploadId: string) =>
      await expect(
        server.rpc.thread.prompt({
          sessionId: "missing-session",
          text: "Hello",
          uploadIds: [uploadId],
        }),
      ).rejects.toThrow();
    const mkdirFailed = await upload(server.rpc, "mkdir.txt", "a");
    // Creating the upload already made this directory; only the release makes it again.
    const releaseMkdir = failFs(
      "mkdir",
      (target) => target === path.join(staging, mkdirFailed),
    );
    await reject(mkdirFailed);
    releaseMkdir.mockRestore();
    const renameFailed = await upload(server.rpc, "rename.txt", "b");
    const rename = failFs("rename", (target) => target.startsWith(attachments));
    await reject(renameFailed);
    rename.mockRestore();
    expect(warn).toHaveBeenCalledWith(
      "Could not release chat uploads:",
      expect.objectContaining({ fileName: "mkdir.txt" }),
    );
    expect(warn).toHaveBeenCalledWith(
      "Could not release chat uploads:",
      expect.objectContaining({ fileName: "rename.txt" }),
    );
    const cleanupFailed = await upload(server.rpc, "cleanup.txt", "c");
    const rm = failFs("rm", (target) => target.startsWith(attachments));
    await reject(cleanupFailed);
    rm.mockRestore();
    expect(warn).toHaveBeenCalledWith(
      "Could not remove released attachment:",
      expect.anything(),
    );
    // The upload still returned to staging.
    expect(await server.rpc.uploads.status({ uploadId: cleanupFailed })).toEqual(
      { received: 1, size: 1 },
    );
    warn.mockRestore();
  },
);

serverTest(
  "rejects a message whose upload cannot be read and keeps the upload",
  async ({ server }) => {
    const attachments = path.join(server.workspaceRoot, "attachments");
    const uploadId = await upload(server.rpc, "unreadable.txt", "secret");
    const session = await server.rpc.thread.new();
    const readFile = failFs("readFile", (target) =>
      target.startsWith(attachments),
    );
    await expect(
      server.rpc.thread.prompt({
        sessionId: session.sessionId,
        text: "Read it",
        uploadIds: [uploadId],
      }),
    ).rejects.toThrow(
      "Could not attach unreadable.txt: could not read the uploaded file",
    );
    readFile.mockRestore();
    expect(await server.rpc.uploads.status({ uploadId })).toEqual({
      received: 6,
      size: 6,
    });
  },
);

serverTest("reports cancellation cleanup failures", async ({ server }) => {
  const staging = path.join(server.workspaceRoot, ".halo", "uploads");
  const { uploadId } = await server.rpc.uploads.create({
    name: "stuck.txt",
    size: 1,
    mimeType: "",
  });
  const rm = failFs("rm", (target) => target.startsWith(staging));
  await expect(server.rpc.uploads.cancel({ uploadId })).rejects.toThrow(
    "Could not remove the upload of stuck.txt.",
  );
  rm.mockRestore();
});

serverTest(
  "deletes an unsent upload a day after its last chunk",
  async ({ server }) => {
    const staging = path.join(server.workspaceRoot, ".halo", "uploads");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { uploadId } = await server.rpc.uploads.create({
      name: "idle.txt",
      size: 2,
      mimeType: "",
    });
    vi.advanceTimersByTime(23 * 60 * 60_000);
    // A chunk restarts the day-long lifetime.
    await server.rpc.uploads.write({
      uploadId,
      offset: 0,
      chunk: new Blob(["a"]),
    });
    vi.advanceTimersByTime(23 * 60 * 60_000);
    expect(await server.rpc.uploads.status({ uploadId })).toEqual({
      received: 1,
      size: 2,
    });
    vi.advanceTimersByTime(2 * 60 * 60_000);
    vi.useRealTimers();
    await expect
      .poll(async () => await fs.readdir(staging))
      .toEqual([]);
    await expect(server.rpc.uploads.status({ uploadId })).rejects.toThrow(
      "This upload no longer exists",
    );
  },
);

serverTest(
  "accepts text-only prompts from clients that still send an empty files list",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    await server.rpc.thread.prompt({
      sessionId: session.sessionId,
      text: "Hello from an older app",
      // Protocol 29 clients always sent this field.
      files: [],
    } as never);
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toBe("Hello from an older app");
      return m.assistant("Hi.");
    });
  },
);

serverTest(
  "cancels during the retry delay without waiting for it to finish",
  async ({ server }) => {
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        if (String(url).includes("/rpc/uploads/write"))
          throw new TypeError("fetch failed");
        return await realFetch(url, init);
      });
    const api = createHaloClient({ transport: server.transport });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    const uploaded = await uploadChatFile({
      api,
      file: new File(["x"], "cancel.txt"),
      signal: controller.signal,
    });
    spy.mockRestore();
    expect(uploaded instanceof Error && uploaded.name).toBe(
      "ChatUploadCancelledError",
    );
    expect(Date.now() - started).toBeLessThan(900);
  },
);

serverTest(
  "logs when a failed claim cannot restore the files it already moved",
  async ({ server }) => {
    const attachments = path.join(server.workspaceRoot, "attachments");
    const session = await server.rpc.thread.new();
    const first = await upload(server.rpc, "first.txt", "a");
    const second = await upload(server.rpc, "second.txt", "b");
    await fs.mkdir(path.join(attachments, second, "second.txt", "blocker"), {
      recursive: true,
    });
    const warn = vi.spyOn(console, "warn");
    // Moving the first file back out of attachments fails too.
    const rename = failFs("rename", (target) =>
      target.startsWith(path.join(attachments, first)),
    );
    await expect(
      server.rpc.thread.prompt({
        sessionId: session.sessionId,
        text: "Both",
        uploadIds: [first, second],
      }),
    ).rejects.toThrow("Could not store second.txt in the workspace.");
    rename.mockRestore();
    expect(warn).toHaveBeenCalledWith(
      "Could not restore claimed uploads:",
      expect.objectContaining({ fileName: "first.txt" }),
    );
    warn.mockRestore();
  },
);

serverTest(
  "logs when an expired upload cannot be removed",
  async ({ server }) => {
    const staging = path.join(server.workspaceRoot, ".halo", "uploads");
    const warn = vi.spyOn(console, "warn");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    await server.rpc.uploads.create({ name: "kept.txt", size: 1, mimeType: "" });
    const rm = failFs("rm", (target) => target.startsWith(staging));
    vi.advanceTimersByTime(25 * 60 * 60_000);
    vi.useRealTimers();
    await expect
      .poll(() =>
        warn.mock.calls.some(
          ([message]) => message === "Could not remove an expired upload:",
        ),
      )
      .toBe(true);
    rm.mockRestore();
    warn.mockRestore();
  },
);

serverTest(
  "stores every byte when the file accepts short writes",
  async ({ server }) => {
    const staging = path.join(server.workspaceRoot, ".halo", "uploads");
    const realOpen = fs.open.bind(fs);
    const limit = { bytes: 3 };
    const shortWrites = vi.spyOn(fs, "open").mockImplementation((async (
      ...args: Parameters<typeof fs.open>
    ) => {
      const handle = await realOpen(...args);
      if (!String(args[0]).startsWith(staging)) return handle;
      const write = handle.write.bind(handle) as (
        ...writeArgs: unknown[]
      ) => Promise<{ bytesWritten: number }>;
      // Store at most `limit.bytes` per call, as a full disk or pipe might.
      handle.write = (async (
        buffer: Uint8Array,
        offset: number,
        length: number,
        position: number,
      ) => {
        if (limit.bytes === 0) return { bytesWritten: 0, buffer };
        return await write(buffer, offset, Math.min(length, limit.bytes), position);
      }) as never;
      return handle;
    }) as never);
    const { uploadId } = await server.rpc.uploads.create({
      name: "short.txt",
      size: 11,
      mimeType: "",
    });
    expect(
      await server.rpc.uploads.write({
        uploadId,
        offset: 0,
        chunk: new Blob(["hello world"]),
      }),
    ).toEqual({ received: 11 });
    expect(
      await fs.readFile(path.join(staging, uploadId, "short.txt"), "utf8"),
    ).toBe("hello world");
    const stalled = await server.rpc.uploads.create({
      name: "stalled.txt",
      size: 2,
      mimeType: "",
    });
    limit.bytes = 0;
    await expect(
      server.rpc.uploads.write({
        uploadId: stalled.uploadId,
        offset: 0,
        chunk: new Blob(["no"]),
      }),
    ).rejects.toThrow("Could not store stalled.txt in the workspace.");
    shortWrites.mockRestore();
    expect(await server.rpc.uploads.status(stalled)).toEqual({
      received: 0,
      size: 2,
    });
  },
);
