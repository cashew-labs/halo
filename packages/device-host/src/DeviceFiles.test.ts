import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import {
  DeviceAccess,
  type DeviceAccessAnswer,
  type DeviceAccessRequest,
  type DeviceGrant,
} from "./DeviceAccess.js";
import { DeviceFiles } from "./DeviceFiles.js";

let home: string;
let documents: string;

beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "device-files-")),
  );
  documents = path.join(home, "Documents");
  await fs.mkdir(documents);
  await fs.writeFile(path.join(documents, "notes.md"), "Buy milk\n");
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

/** A computer whose person answers every prompt with `answer`. */
function device(
  input: {
    answer?: DeviceAccessAnswer;
    grants?: DeviceGrant[];
  } = {},
) {
  const saved: DeviceGrant[][] = [];
  const ask = vi.fn(
    async (_request: DeviceAccessRequest): Promise<DeviceAccessAnswer> =>
      await Promise.resolve(input.answer ?? "deny"),
  );
  const access = new DeviceAccess({
    grants: input.grants ?? [],
    home,
    ask,
    save: async (grants) => {
      saved.push(grants);
      await Promise.resolve();
    },
  });
  return { files: new DeviceFiles({ access }), access, ask, saved };
}

const read = (filePath: string) =>
  ({
    type: "files.read",
    path: filePath,
    encoding: "utf8",
    maxBytes: 1024,
  }) as const;

test("asks once for a new folder, then remembers the answer", async () => {
  const { files, ask, saved } = device({ answer: "read" });
  const notes = path.join(documents, "notes.md");
  expect(await files.run(read(notes))).toMatchObject({ data: "Buy milk\n" });
  expect(await files.run(read(notes))).toMatchObject({ data: "Buy milk\n" });
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0]?.[0]).toMatchObject({
    folder: documents,
    access: "read",
    path: notes,
  });
  expect(saved).toEqual([[{ path: documents, access: "read" }]]);
});

test("listing a folder asks about that folder", async () => {
  const { files, ask } = device({ answer: "write" });
  const listed = await files.run({ type: "files.list", path: documents });
  if (listed instanceof Error) throw listed;
  expect(listed.entries.map((entry) => entry.name)).toEqual(["notes.md"]);
  expect(ask.mock.calls[0]?.[0]).toMatchObject({ folder: documents });
});

test("concurrent requests in one folder share a single prompt", async () => {
  const { files, ask } = device({ answer: "read" });
  await fs.writeFile(path.join(documents, "todo.md"), "Call the bank\n");
  const results = await Promise.all([
    files.run(read(path.join(documents, "notes.md"))),
    files.run(read(path.join(documents, "todo.md"))),
  ]);
  expect(results).toMatchObject([
    { data: "Buy milk\n" },
    { data: "Call the bank\n" },
  ]);
  expect(ask).toHaveBeenCalledTimes(1);
});

test("a refusal is not asked again until the grants change", async () => {
  const { files, access, ask } = device({ answer: "deny" });
  const notes = path.join(documents, "notes.md");
  expect(await files.run(read(notes))).toMatchObject({
    code: "access_denied",
  });
  expect(await files.run(read(notes))).toMatchObject({
    code: "access_denied",
  });
  expect(ask).toHaveBeenCalledTimes(1);
  access.setGrants([{ path: documents, access: "read" }]);
  expect(await files.run(read(notes))).toMatchObject({ data: "Buy milk\n" });
});

test("a change in a read-only folder asks to allow changes", async () => {
  const notes = path.join(documents, "notes.md");
  const { files, ask } = device({
    answer: "read",
    grants: [{ path: documents, access: "read" }],
  });
  expect(await files.run(read(notes))).toMatchObject({ data: "Buy milk\n" });
  expect(ask).not.toHaveBeenCalled();
  expect(
    await files.run({
      type: "files.write",
      path: notes,
      data: "changed",
      encoding: "utf8",
    }),
  ).toMatchObject({ code: "read_only" });
  expect(ask.mock.calls[0]?.[0]).toMatchObject({ access: "write" });
  expect(await fs.readFile(notes, "utf8")).toBe("Buy milk\n");
});

test("credential folders are refused without asking", async () => {
  await fs.mkdir(path.join(home, ".ssh"));
  await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "key");
  const { files, ask } = device({
    answer: "write",
    grants: [{ path: home, access: "write" }],
  });
  expect(
    await files.run(read(path.join(home, ".ssh", "id_ed25519"))),
  ).toMatchObject({ code: "protected_path" });
  expect(ask).not.toHaveBeenCalled();
});

test("a symlink out of an allowed folder asks about its real location", async () => {
  const elsewhere = path.join(home, "Private");
  await fs.mkdir(elsewhere);
  await fs.writeFile(path.join(elsewhere, "secret.txt"), "private");
  await fs.symlink(
    path.join(elsewhere, "secret.txt"),
    path.join(documents, "link.txt"),
  );
  const { files, ask } = device({
    answer: "deny",
    grants: [{ path: documents, access: "write" }],
  });
  expect(await files.run(read(path.join(documents, "link.txt")))).toMatchObject(
    { code: "access_denied" },
  );
  expect(ask.mock.calls[0]?.[0]).toMatchObject({ folder: elsewhere });
});

test("an unanswered or failed prompt refuses access", async () => {
  const access = new DeviceAccess({
    grants: [],
    home,
    ask: async () => await Promise.reject(new Error("prompt closed")),
    save: async () => await Promise.resolve(),
  });
  expect(
    await new DeviceFiles({ access }).run(
      read(path.join(documents, "notes.md")),
    ),
  ).toMatchObject({ code: "access_denied" });
});

test("reports binary and oversized files instead of returning garbled text", async () => {
  const image = path.join(documents, "photo.png");
  await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  const { files } = device({ grants: [{ path: documents, access: "read" }] });
  expect(await files.run(read(image))).toMatchObject({ code: "binary_file" });
  expect(await files.run({ ...read(image), encoding: "base64" })).toMatchObject(
    { data: "iVBORwAB", size: 6 },
  );
  expect(
    await files.run({ ...read(image), encoding: "base64", maxBytes: 2 }),
  ).toMatchObject({ code: "too_large" });
});

test("writes create folders, and deletes remove files but not folders", async () => {
  const { files } = device({ grants: [{ path: documents, access: "write" }] });
  const plan = path.join(documents, "drafts", "plan.md");
  expect(
    await files.run({
      type: "files.write",
      path: plan,
      data: "Ship it\n",
      encoding: "utf8",
    }),
  ).toEqual({ path: plan, size: 8 });
  expect(await files.run({ type: "files.delete", path: plan })).toEqual({
    path: plan,
  });
  expect(
    await files.run({ type: "files.delete", path: documents }),
  ).toMatchObject({ code: "is_directory" });
});
