import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import {
  ChatUploadRejectedError,
  createHaloClient,
  sessionMessages,
  uploadChatFile,
} from "@get-halo/client";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { serverTest } from "../serverTest.js";

const chunk = 8 * 1024 * 1024;

serverTest(
  "uploads a multi-chunk file and gives the model its workspace path when it cannot be read inline",
  async ({ server, llm }) => {
    const bytes = crypto.randomBytes(chunk + 1234);
    const file = new File([bytes], "archive.bin", {
      type: "application/octet-stream",
    });
    const progress: number[] = [];
    const uploaded = await uploadChatFile({
      api: server.rpc,
      file,
      onProgress: (received) => progress.push(received),
    });
    if (uploaded instanceof Error) throw uploaded;
    expect(progress).toEqual([chunk, chunk + 1234]);
    expect(
      await server.rpc.uploads.status({ uploadId: uploaded.uploadId }),
    ).toEqual({ received: chunk + 1234, size: chunk + 1234 });

    const session = await server.rpc.thread.new();
    await server.rpc.thread.prompt({
      sessionId: session.sessionId,
      text: "What is in this archive?",
      uploadIds: [uploaded.uploadId],
    });
    await llm.respond(({ messages }) => {
      const user = messages.findLast((message) => message.role === "user")!;
      const text = messageText(user);
      expect(text).toContain(
        `Workspace path: "attachments/${uploaded.uploadId}/archive.bin"`,
      );
      expect(text).toContain("The contents are not included");
      expect(text).toContain("Halo cannot extract text from this file format");
      return m.assistant("It is a binary archive.");
    });
    const stored = await fs.readFile(
      path.join(
        server.workspaceRoot,
        "attachments",
        uploaded.uploadId,
        "archive.bin",
      ),
    );
    expect(stored.equals(bytes)).toBe(true);
    expect(
      await fs.readdir(path.join(server.workspaceRoot, ".halo", "uploads")),
    ).toEqual([]);
    const snapshot = await server.rpc.thread.snapshot({
      sessionId: session.sessionId,
    });
    const message = sessionMessages(snapshot).find(
      (candidate) => candidate.role === "user",
    );
    expect(message?.role === "user" && message.attachments).toEqual([
      {
        name: "archive.bin",
        path: `attachments/${uploaded.uploadId}/archive.bin`,
        size: chunk + 1234,
        mimeType: "application/octet-stream",
      },
    ]);
    await expect(
      server.rpc.uploads.status({ uploadId: uploaded.uploadId }),
    ).rejects.toThrow("This upload no longer exists");
  },
);

serverTest(
  "includes readable uploads and omits files over the inline size",
  async ({ server, llm }) => {
    const notes = await uploadChatFile({
      api: server.rpc,
      file: new File(["The bird is a scarlet robin."], "notes.txt", {
        type: "text/plain",
      }),
    });
    if (notes instanceof Error) throw notes;
    const large = await uploadChatFile({
      api: server.rpc,
      file: new File(["a".repeat(20_000_001)], "large.txt", {
        type: "text/plain",
      }),
    });
    if (large instanceof Error) throw large;
    const session = await server.rpc.thread.new();
    await server.rpc.thread.prompt({
      sessionId: session.sessionId,
      text: "Read these",
      uploadIds: [notes.uploadId, large.uploadId],
    });
    await llm.respond(({ messages }) => {
      const text = messageText(
        messages.findLast((message) => message.role === "user")!,
      );
      expect(text).toContain("The bird is a scarlet robin.");
      expect(text).toContain("the file is larger than 20 MB");
      expect(text).not.toContain("aaaaaaaaaa");
      return m.assistant("Done.");
    });
  },
);

serverTest(
  "resumes from the stored offset and ignores repeated chunks",
  async ({ server }) => {
    const bytes = crypto.randomBytes(chunk + 10);
    const { uploadId } = await server.rpc.uploads.create({
      name: "resume.bin",
      size: bytes.length,
      mimeType: "",
    });
    const first = new Blob([bytes.subarray(0, chunk)]);
    expect(
      await server.rpc.uploads.write({ uploadId, offset: 0, chunk: first }),
    ).toEqual({ received: chunk });
    // A retry after a lost response does not append the chunk twice.
    expect(
      await server.rpc.uploads.write({ uploadId, offset: 0, chunk: first }),
    ).toEqual({ received: chunk });
    await expect(
      server.rpc.uploads.write({
        uploadId,
        offset: chunk + 5,
        chunk: new Blob([bytes.subarray(chunk + 5)]),
      }),
    ).rejects.toThrow(
      `The upload expected data at byte ${chunk}, not ${chunk + 5}.`,
    );
    await expect(
      server.rpc.uploads.write({
        uploadId,
        offset: chunk,
        chunk: new Blob([bytes.subarray(chunk), Buffer.from("extra")]),
      }),
    ).rejects.toThrow(
      "resume.bin is larger than the size given when its upload started.",
    );
    await expect(
      server.rpc.uploads.write({
        uploadId,
        offset: chunk,
        chunk: new Blob([new Uint8Array(chunk + 1)]),
      }),
    ).rejects.toThrow("Upload chunks must contain 1 byte to 8 MiB.");
    expect(await server.rpc.uploads.status({ uploadId })).toEqual({
      received: chunk,
      size: chunk + 10,
    });
    const session = await server.rpc.thread.new();
    await expect(
      server.rpc.thread.prompt({
        sessionId: session.sessionId,
        text: "Too early",
        uploadIds: [uploadId],
      }),
    ).rejects.toThrow("resume.bin is still uploading.");
    expect(
      await server.rpc.uploads.write({
        uploadId,
        offset: chunk,
        chunk: new Blob([bytes.subarray(chunk)]),
      }),
    ).toEqual({ received: chunk + 10 });
    const staged = await fs.readFile(
      path.join(server.workspaceRoot, ".halo", "uploads", uploadId, "resume.bin"),
    );
    expect(staged.equals(bytes)).toBe(true);
  },
);

serverTest(
  "keeps uploads available when their message is rejected",
  async ({ server, llm }) => {
    const uploaded = await uploadChatFile({
      api: server.rpc,
      file: new File(["coral raven"], "kept.txt", { type: "text/plain" }),
    });
    if (uploaded instanceof Error) throw uploaded;
    await expect(
      server.rpc.thread.prompt({
        sessionId: "missing-session",
        text: "Hello",
        uploadIds: [uploaded.uploadId],
      }),
    ).rejects.toThrow();
    expect(
      await server.rpc.uploads.status({ uploadId: uploaded.uploadId }),
    ).toEqual({ received: 11, size: 11 });
    await expect(
      fs.access(path.join(server.workspaceRoot, "attachments", uploaded.uploadId)),
    ).rejects.toThrow();
    const session = await server.rpc.thread.new();
    await server.rpc.thread.prompt({
      sessionId: session.sessionId,
      text: "Hello again",
      uploadIds: [uploaded.uploadId],
    });
    await llm.respond(({ messages }) => {
      expect(
        messageText(messages.findLast((message) => message.role === "user")!),
      ).toContain("coral raven");
      return m.assistant("Got it.");
    });
  },
);

serverTest("rejects uploads over the file type limits", async ({ server }) => {
  await expect(
    server.rpc.uploads.create({
      name: "photo.png",
      size: 20_000_001,
      mimeType: "image/png",
    }),
  ).rejects.toThrow("photo.png is too large. Images can be up to 20 MB.");
  await expect(
    server.rpc.uploads.create({
      name: "sheet.csv",
      size: 50_000_001,
      mimeType: "text/csv",
    }),
  ).rejects.toThrow("sheet.csv is too large. Spreadsheets can be up to 50 MB.");
  await expect(
    server.rpc.uploads.create({
      name: "video.mov",
      size: 512_000_001,
      mimeType: "video/quicktime",
    }),
  ).rejects.toThrow("video.mov is too large. Files can be up to 512 MB.");
  await expect(
    server.rpc.uploads.create({ name: "../x", size: 1, mimeType: "" }),
  ).rejects.toThrow("The attachment has an invalid filename.");
  await expect(
    server.rpc.uploads.create({ name: "x.txt", size: 1.5, mimeType: "" }),
  ).rejects.toThrow("The file size is invalid.");
  const uploaded = await uploadChatFile({
    api: server.rpc,
    file: new File(["photo"], "photo.png"),
  });
  expect(uploaded).not.toBeInstanceOf(Error);
  const tooLarge = await uploadChatFile({
    api: server.rpc,
    file: new File([new Uint8Array(20_000_001)], "big.png"),
  });
  expect(tooLarge).toBeInstanceOf(ChatUploadRejectedError);
});

serverTest(
  "cancels uploads and removes staged files left by a previous server",
  async ({ server }) => {
    const { uploadId } = await server.rpc.uploads.create({
      name: "draft.txt",
      size: 5,
      mimeType: "text/plain",
    });
    const staging = path.join(server.workspaceRoot, ".halo", "uploads");
    expect(await fs.readdir(staging)).toEqual([uploadId]);
    await server.rpc.uploads.cancel({ uploadId });
    // Cancelling twice is harmless.
    await server.rpc.uploads.cancel({ uploadId });
    expect(await fs.readdir(staging)).toEqual([]);
    await expect(server.rpc.uploads.status({ uploadId })).rejects.toThrow(
      "This upload no longer exists",
    );
    const left = await server.rpc.uploads.create({
      name: "left.txt",
      size: 5,
      mimeType: "text/plain",
    });
    await server.stop();
    await server.start();
    expect(await fs.readdir(staging)).toEqual([]);
    await expect(
      server.rpc.uploads.status({ uploadId: left.uploadId }),
    ).rejects.toThrow("This upload no longer exists");
  },
);

serverTest(
  "rejects prompts with legacy file inputs instead of dropping the files",
  async ({ server }) => {
    const session = await server.rpc.thread.new();
    await expect(
      server.rpc.thread.prompt({
        sessionId: session.sessionId,
        text: "Hello",
        // Protocol 29 clients sent File objects with the prompt.
        files: [new File(["old"], "old.txt")],
      } as never),
    ).rejects.toThrow("Update Halo to attach files.");
  },
);

serverTest(
  "retries a failed chunk from the offset the server stored",
  async ({ server }) => {
    const realFetch = globalThis.fetch;
    let failed = false;
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        if (!failed && String(url).includes("/rpc/uploads/write")) {
          failed = true;
          throw new TypeError("fetch failed");
        }
        return await realFetch(url, init);
      });
    const api = createHaloClient({ transport: server.transport });
    const bytes = crypto.randomBytes(chunk + 3);
    const uploaded = await uploadChatFile({
      api,
      file: new File([bytes], "retry.bin"),
    });
    spy.mockRestore();
    if (uploaded instanceof Error) throw uploaded;
    expect(failed).toBe(true);
    expect(
      await server.rpc.uploads.status({ uploadId: uploaded.uploadId }),
    ).toEqual({ received: chunk + 3, size: chunk + 3 });
  },
);

serverTest("stops an upload when its signal aborts", async ({ server }) => {
  const controller = new AbortController();
  controller.abort();
  const uploaded = await uploadChatFile({
    api: server.rpc,
    file: new File(["x"], "aborted.txt"),
    signal: controller.signal,
  });
  expect(uploaded).toBeInstanceOf(Error);
  expect(uploaded instanceof Error && uploaded.name).toBe(
    "ChatUploadCancelledError",
  );
});

const fixtures = path.resolve(import.meta.dirname, "../fixtures/attachments");

serverTest(
  "omits files that would exceed the text, image, or PDF page budgets",
  async ({ server, llm }) => {
    const directory = await fs.mkdtemp(
      path.join(server.harness.paths.root, "pdfs-"),
    );
    const execFile = (await import("node:util")).promisify(
      (await import("node:child_process")).execFile,
    );
    const pdf = (pages: number) => path.join(directory, `${pages}-pages.pdf`);
    // Each fixture copy adds two pages.
    for (const pages of [20, 22])
      await execFile("pdfunite", [
        ...Array.from({ length: pages / 2 }, () =>
          path.join(fixtures, "document.pdf"),
        ),
        pdf(pages),
      ]);
    const upload = async (file: File) => {
      const uploaded = await uploadChatFile({ api: server.rpc, file });
      if (uploaded instanceof Error) throw uploaded;
      return uploaded.uploadId;
    };
    const pdfFile = async (pages: number, name: string) =>
      new File([await fs.readFile(pdf(pages))], name, {
        type: "application/pdf",
      });
    const uploadIds = [
      await upload(new File(["a".repeat(150_000)], "first.txt")),
      await upload(new File(["b".repeat(150_000)], "second.txt")),
      await upload(await pdfFile(22, "long.pdf")),
      await upload(await pdfFile(20, "one.pdf")),
      await upload(await pdfFile(20, "two.pdf")),
      await upload(await pdfFile(20, "three.pdf")),
    ];
    const session = await server.rpc.thread.new();
    await server.rpc.thread.prompt({
      sessionId: session.sessionId,
      text: "Summarize",
      uploadIds,
    });
    await llm.respond(({ messages }) => {
      const text = messageText(
        messages.findLast((message) => message.role === "user")!,
      );
      expect(text).toContain(
        "second.txt\"\nWorkspace path",
      );
      expect(text).toContain(
        "its extracted text would exceed the 200,000-character limit for one message",
      );
      expect(text).toContain("only PDFs with 1 to 20 pages are included");
      expect(text).toContain(
        "it would exceed the limit of 40 images or PDF pages for one message",
      );
      return m.assistant("Done.");
    });
  },
);

serverTest(
  "rejects uploads that would fill the workspace disk",
  async ({ server }) => {
    const fsPromises = (await import("node:fs/promises")).default;
    const statfs = vi.spyOn(fsPromises, "statfs").mockResolvedValue({
      bavail: 300,
      bsize: 1_000_000,
    } as Awaited<ReturnType<typeof fsPromises.statfs>>);
    await expect(
      server.rpc.uploads.create({
        name: "movie.mp4",
        size: 100_000_000,
        mimeType: "video/mp4",
      }),
    ).rejects.toThrow(
      "The workspace does not have enough free disk space for movie.mp4.",
    );
    const small = await server.rpc.uploads.create({
      name: "small.txt",
      size: 40_000_000,
      mimeType: "text/plain",
    });
    // The unfinished upload's remaining bytes count against free space.
    await expect(
      server.rpc.uploads.create({
        name: "second.txt",
        size: 10_000_000,
        mimeType: "text/plain",
      }),
    ).rejects.toThrow("enough free disk space for second.txt");
    statfs.mockRestore();
    await server.rpc.uploads.cancel(small);
  },
);

serverTest(
  "gives up after repeated failures and keeps retrying through status failures",
  { timeout: 60_000 },
  async ({ server }) => {
    const realFetch = globalThis.fetch;
    const failures = { write: 1, status: 1 };
    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        for (const method of ["write", "status"] as const)
          if (
            String(url).includes(`/rpc/uploads/${method}`) &&
            failures[method] > 0
          ) {
            failures[method]--;
            throw new TypeError("fetch failed");
          }
        return await realFetch(url, init);
      });
    const api = createHaloClient({ transport: server.transport });
    const recovered = await uploadChatFile({
      api,
      file: new File(["recovered"], "recovered.txt"),
    });
    expect(recovered).not.toBeInstanceOf(Error);
    failures.write = 10;
    const failed = await uploadChatFile({
      api,
      file: new File(["lost"], "lost.txt"),
    });
    spy.mockRestore();
    expect(failed).toBeInstanceOf(Error);
    expect(failed instanceof Error && failed.message).toBe(
      "Couldn't upload lost.txt. Check your connection and try again.",
    );
    // Giving up also removes the staged upload; the recovered one remains.
    expect(
      await fs.readdir(path.join(server.workspaceRoot, ".halo", "uploads")),
    ).toHaveLength(1);
    // A failed cleanup is logged, and the upload error is still returned.
    failures.write = 10;
    const warn = vi.spyOn(console, "warn");
    const cancel = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        if (
          String(url).includes("/rpc/uploads/write") ||
          String(url).includes("/rpc/uploads/cancel")
        )
          throw new TypeError("fetch failed");
        return await realFetch(url, init);
      });
    const stranded = await uploadChatFile({
      api,
      file: new File(["kept"], "stranded.txt"),
    });
    cancel.mockRestore();
    expect(stranded instanceof Error && stranded.message).toBe(
      "Couldn't upload stranded.txt. Check your connection and try again.",
    );
    expect(warn).toHaveBeenCalledWith(
      "Could not cancel upload:",
      expect.objectContaining({ fileName: "stranded.txt" }),
    );
    warn.mockRestore();
  },
);

serverTest(
  "cancels the server upload when the client stops partway",
  async ({ server }) => {
    const staging = path.join(server.workspaceRoot, ".halo", "uploads");
    const controller = new AbortController();
    const uploaded = await uploadChatFile({
      api: server.rpc,
      file: new File([crypto.randomBytes(chunk * 2)], "partial.bin"),
      signal: controller.signal,
      // Abort after the finished chunk's response stream has closed.
      onProgress: () => setTimeout(() => controller.abort(), 0),
    });
    expect(uploaded instanceof Error && uploaded.name).toBe(
      "ChatUploadCancelledError",
    );
    expect(await fs.readdir(staging)).toEqual([]);
  },
);
