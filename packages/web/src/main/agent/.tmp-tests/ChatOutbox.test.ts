import { ORPCError } from "@orpc/client";
import { describe, expect, test, vi } from "vitest";
import type { HaloClient } from "@get-halo/client";
import { ChatOutbox } from "../ChatOutbox.js";
import { ChatUploads } from "../ChatUploads.js";

/** A fake workspace client whose upload chunks wait until released. */
function fakeClient(options: { holdWrites?: boolean } = {}) {
  let nextUploadId = 0;
  const pendingWrites: (() => void)[] = [];
  let activeCreates = 0;
  const calls = {
    maxActiveCreates: 0,
    cancelled: [] as string[],
    prompts: [] as { text: string; uploadIds?: string[] }[],
  };
  const failWrites = new Set<string>();
  const sizes = new Map<string, number>();
  const client = {
    uploads: {
      create: vi.fn(async (input: { name: string; size: number }) => {
        activeCreates++;
        calls.maxActiveCreates = Math.max(calls.maxActiveCreates, activeCreates);
        await Promise.resolve();
        activeCreates--;
        const uploadId = `upload-${++nextUploadId}`;
        sizes.set(uploadId, input.size);
        if (input.name.startsWith("fail")) failWrites.add(uploadId);
        return { uploadId };
      }),
      write: vi.fn(
        async (
          input: { uploadId: string; offset: number; chunk: Blob },
          _options?: { signal?: AbortSignal },
        ) => {
          if (options.holdWrites)
            await new Promise<void>((resolve) => pendingWrites.push(resolve));
          if (failWrites.has(input.uploadId))
            throw new ORPCError("BAD_REQUEST", {
              message: "This upload no longer exists. Attach the file again.",
            });
          return { received: input.offset + input.chunk.size };
        },
      ),
      status: vi.fn(async ({ uploadId }: { uploadId: string }) => {
        if (failWrites.has(uploadId))
          throw new ORPCError("BAD_REQUEST", {
            message: "This upload no longer exists. Attach the file again.",
          });
        return { received: 0, size: sizes.get(uploadId) ?? 0 };
      }),
      cancel: vi.fn(async ({ uploadId }: { uploadId: string }) => {
        calls.cancelled.push(uploadId);
      }),
    },
    thread: {
      prompt: vi.fn(
        async (input: {
          sessionId: string;
          text: string;
          uploadIds?: string[];
        }) => {
          calls.prompts.push({ text: input.text, uploadIds: input.uploadIds });
          if (input.text === "rejected")
            throw new ORPCError("BAD_REQUEST", { message: "Rejected." });
          if (input.text === "offline") throw new TypeError("fetch failed");
          return { submissionId: calls.prompts.length };
        },
      ),
    },
  };
  return {
    // SAFETY: The tests call only the upload and prompt procedures above.
    api: client as unknown as HaloClient,
    client,
    calls,
    releaseWrites() {
      for (const resolve of pendingWrites.splice(0)) resolve();
    },
    pendingWrites,
  };
}

const file = (name: string, text = "data") => new File([text], name);

async function settled(uploads: ChatUploads, attachmentIds: string[]) {
  return await uploads.uploadIds(attachmentIds);
}

describe("ChatUploads", () => {
  test("uploads at most three files at a time and reports upload IDs", async () => {
    const fake = fakeClient();
    const uploads = new ChatUploads({ api: fake.api });
    const ids = uploads.add([1, 2, 3, 4, 5].map((n) => file(`${n}.txt`)));
    expect(await settled(uploads, ids)).toEqual([
      "upload-1",
      "upload-2",
      "upload-3",
      "upload-4",
      "upload-5",
    ]);
    expect(fake.calls.maxActiveCreates).toBeLessThanOrEqual(3);
    expect(uploads.state.latestValue.get(ids[0]!)?.state).toBe("uploaded");
  });

  test("marks failures, retries them, and reports removed attachments", async () => {
    const fake = fakeClient();
    const uploads = new ChatUploads({ api: fake.api });
    const [failed] = uploads.add([file("fail.txt")]);
    const result = await settled(uploads, [failed!]);
    expect(result).toBeInstanceOf(Error);
    expect(result instanceof Error && result.message).toBe(
      "This upload no longer exists. Attach the file again.",
    );
    expect(uploads.state.latestValue.get(failed!)?.state).toBe("failed");
    // Retrying a file that is not failed does nothing.
    const [ok] = uploads.add([file("ok.txt")]);
    await settled(uploads, [ok!]);
    uploads.retry(ok!);
    expect(uploads.state.latestValue.get(ok!)?.state).toBe("uploaded");
    uploads.retry(failed!);
    expect(uploads.state.latestValue.get(failed!)?.state).toBe("uploading");
    uploads.remove([failed!]);
    const removed = await settled(uploads, [failed!]);
    expect(removed instanceof Error && removed.message).toBe(
      "An attachment was removed before it was sent.",
    );
  });

  test("cancels server uploads for removed attachments and on close", async () => {
    const fake = fakeClient({ holdWrites: true });
    const uploads = new ChatUploads({ api: fake.api });
    const [held] = uploads.add([file("held.txt")]);
    await vi.waitFor(() => expect(fake.pendingWrites).toHaveLength(1));
    // The write finishes even though the attachment was removed meanwhile.
    uploads.remove([held!]);
    fake.releaseWrites();
    await vi.waitFor(() => expect(fake.calls.cancelled).toContain("upload-1"));
    expect(uploads.state.latestValue.has(held!)).toBe(false);

    const [done] = uploads.add([file("done.txt")]);
    await vi.waitFor(() => expect(fake.pendingWrites).toHaveLength(1));
    fake.releaseWrites();
    await settled(uploads, [done!]);
    uploads.close();
    expect(fake.calls.cancelled).toContain("upload-2");
    expect(uploads.state.latestValue.size).toBe(0);
  });

  test("stops waiting for upload IDs when the signal aborts", async () => {
    const fake = fakeClient({ holdWrites: true });
    const uploads = new ChatUploads({ api: fake.api });
    const [attachmentId] = uploads.add([file("slow.txt")]);
    const before = new AbortController();
    before.abort();
    expect(
      (await uploads.uploadIds([attachmentId!], before.signal)) instanceof Error,
    ).toBe(true);
    const during = new AbortController();
    const waiting = uploads.uploadIds([attachmentId!], during.signal);
    during.abort();
    const result = await waiting;
    expect(result instanceof Error && result.name).toBe(
      "ChatUploadWaitCancelledError",
    );
    uploads.close();
  });
});

test("keeps working when cancelling a removed upload fails", async () => {
  const fake = fakeClient();
  fake.client.uploads.cancel.mockRejectedValue(new TypeError("fetch failed"));
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  const uploads = new ChatUploads({ api: fake.api });
  const [attachmentId] = uploads.add([file("kept.txt")]);
  await settled(uploads, [attachmentId!]);
  expect(() => uploads.remove([attachmentId!])).not.toThrow();
  await vi.waitFor(() =>
    expect(warn).toHaveBeenCalledWith(
      "Could not cancel upload:",
      expect.any(TypeError),
    ),
  );
  warn.mockRestore();
});

describe("ChatOutbox", () => {
  test("sends waiting messages in order once their uploads finish", async () => {
    const fake = fakeClient({ holdWrites: true });
    const outbox = new ChatOutbox({ api: fake.api });
    const [attachmentId] = outbox.uploads.add([file("first.txt")]);
    outbox.enqueue({
      queuedAt: 0,
      messageId: "first",
      sessionId: "s1",
      draft: {
        text: " first ",
        attachmentIds: [attachmentId!],
        files: [file("first.txt")],
        references: [],
      },
    });
    outbox.enqueue({
      queuedAt: 0,
      messageId: "second",
      sessionId: "s1",
      draft: { text: "second", attachmentIds: [], files: [], references: [] },
    });
    await vi.waitFor(() => expect(fake.pendingWrites).toHaveLength(1));
    expect(fake.calls.prompts).toEqual([]);
    expect(outbox.state.latestValue.map((message) => message.state)).toEqual([
      "waiting",
      "waiting",
    ]);
    fake.releaseWrites();
    await vi.waitFor(() => expect(fake.calls.prompts).toHaveLength(2));
    expect(fake.calls.prompts).toEqual([
      { text: "first", uploadIds: ["upload-1"] },
      { text: "second", uploadIds: [] },
    ]);
    expect(outbox.state.latestValue).toMatchObject([
      { messageId: "first", state: "sent", submissionId: 1 },
      { messageId: "second", state: "sent", submissionId: 2 },
    ]);
    // Sent uploads belong to the server now.
    expect(outbox.uploads.state.latestValue.size).toBe(0);
    outbox.forget(["first", undefined]);
    expect(outbox.state.latestValue.map((message) => message.messageId)).toEqual(
      ["second"],
    );
    // Forgetting a message that is not sent keeps it.
    outbox.forget(["missing"]);
    expect(outbox.state.latestValue).toHaveLength(1);
  });

  test("returns a failed message and the ones behind it, in order", async () => {
    const fake = fakeClient();
    const outbox = new ChatOutbox({ api: fake.api });
    const [attachmentId] = outbox.uploads.add([file("fail.txt")]);
    outbox.enqueue({
      queuedAt: 0,
      messageId: "a",
      sessionId: "s1",
      draft: {
        text: "A",
        attachmentIds: [attachmentId!],
        files: [file("fail.txt")],
        references: [],
      },
    });
    outbox.enqueue({
      queuedAt: 0,
      messageId: "b",
      sessionId: "s1",
      draft: { text: "B", attachmentIds: [], files: [], references: [] },
    });
    // The failed chunk is retried once after a second before the status check.
    await vi.waitFor(
      () =>
        expect(
          outbox.state.latestValue.every(
            (message) => message.state === "returned",
          ),
        ).toBe(true),
      { timeout: 5000 },
    );
    expect(outbox.takeReturned("other")).toEqual([]);
    const returned = outbox.takeReturned("s1");
    expect(
      returned.map((message) => [message.draft.text, message.error]),
    ).toEqual([
      ["A", "This upload no longer exists. Attach the file again."],
      ["B", undefined],
    ]);
    expect(outbox.state.latestValue).toEqual([]);
    // B was aborted before its turn, so nothing was sent.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls.prompts).toEqual([]);
  });

  test("reports server rejections and connection failures", async () => {
    const fake = fakeClient();
    const outbox = new ChatOutbox({ api: fake.api });
    for (const text of ["rejected", "offline"])
      outbox.enqueue({
        queuedAt: 0,
        messageId: text,
        sessionId: text,
        draft: { text, attachmentIds: [], files: [], references: [] },
      });
    await vi.waitFor(() =>
      expect(
        outbox.state.latestValue.filter((message) => message.state === "returned"),
      ).toHaveLength(2),
    );
    expect(outbox.takeReturned("rejected")[0]?.error).toBe("Rejected.");
    expect(outbox.takeReturned("offline")[0]?.error).toBe(
      "Couldn't send your message. Please try again.",
    );
  });

  test("withdraws only waiting messages and closes every wait", async () => {
    const fake = fakeClient({ holdWrites: true });
    const outbox = new ChatOutbox({ api: fake.api });
    const [first] = outbox.uploads.add([file("one.txt")]);
    outbox.enqueue({
      queuedAt: 0,
      messageId: "one",
      sessionId: "s1",
      draft: {
        text: "one",
        attachmentIds: [first!],
        files: [file("one.txt")],
        references: [],
      },
    });
    expect(outbox.withdraw("missing")).toBeUndefined();
    expect(outbox.withdraw("one")?.draft.text).toBe("one");
    expect(outbox.state.latestValue).toEqual([]);
    // The attachment keeps uploading for the draft.
    expect(outbox.uploads.state.latestValue.get(first!)?.state).toBe("uploading");
    outbox.enqueue({
      queuedAt: 0,
      messageId: "two",
      sessionId: "s1",
      draft: {
        text: "two",
        attachmentIds: [first!],
        files: [file("one.txt")],
        references: [],
      },
    });
    outbox.close();
    fake.releaseWrites();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(fake.calls.prompts).toEqual([]);
  });

  test("keeps each composer's attachments", () => {
    const outbox = new ChatOutbox({ api: fakeClient().api });
    expect(outbox.draftAttachments("s1")).toEqual([]);
    outbox.setDraftAttachments("s1", ["a", "b"]);
    expect(outbox.draftAttachments("s1")).toEqual(["a", "b"]);
    outbox.setDraftAttachments("s1", []);
    expect(outbox.drafts.latestValue.has("s1")).toBe(false);
    const replacement = fakeClient();
    outbox.setApi(replacement.api);
    outbox.enqueue({
      queuedAt: 0,
      messageId: "m",
      sessionId: "s1",
      draft: { text: "hi", attachmentIds: [], files: [], references: [] },
    });
    return vi.waitFor(() =>
      expect(replacement.calls.prompts).toEqual([
        { text: "hi", uploadIds: [] },
      ]),
    );
  });
});
