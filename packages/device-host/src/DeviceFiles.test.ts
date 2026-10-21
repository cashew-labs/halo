import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { DeviceFiles, type DeviceFilePolicy } from "./DeviceFiles.js";

let home: string;
let shared: string;

beforeEach(async () => {
  home = await fs.realpath(
    await fs.mkdtemp(path.join(os.tmpdir(), "device-files-")),
  );
  shared = path.join(home, "Documents");
  await fs.mkdir(shared);
  await fs.writeFile(path.join(shared, "notes.md"), "Buy milk\n");
});

afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
});

function files(policy: Partial<DeviceFilePolicy> = {}) {
  return new DeviceFiles({
    access: "write",
    roots: [shared],
    home,
    ...policy,
  });
}

test("reads, writes, and lists files inside a shared folder", async () => {
  const device = files();
  const target = path.join(shared, "drafts", "plan.md");
  expect(
    await device.run({
      type: "files.write",
      path: target,
      data: "Ship it\n",
      encoding: "utf8",
    }),
  ).toEqual({ path: target, size: 8 });
  expect(
    await device.run({
      type: "files.read",
      path: target,
      encoding: "utf8",
      maxBytes: 1024,
    }),
  ).toEqual({ path: target, data: "Ship it\n", size: 8 });
  const listed = await device.run({ type: "files.list", path: shared });
  if (listed instanceof Error) throw listed;
  expect(
    new Set(listed.entries.map((entry) => `${entry.name}:${entry.type}`)),
  ).toEqual(new Set(["drafts:directory", "notes.md:file"]));
});

test("refuses paths outside shared folders, including through symlinks", async () => {
  const device = files();
  const secret = path.join(home, "secret.txt");
  await fs.writeFile(secret, "private");
  await fs.symlink(secret, path.join(shared, "link.txt"));
  for (const target of [
    secret,
    path.join(shared, "..", "secret.txt"),
    path.join(shared, "link.txt"),
  ]) {
    const read = await device.run({
      type: "files.read",
      path: target,
      encoding: "utf8",
      maxBytes: 1024,
    });
    expect(read).toMatchObject({ code: "outside_allowed_folders" });
  }
});

test("never serves credential folders, even inside a shared home folder", async () => {
  await fs.mkdir(path.join(home, ".ssh"));
  await fs.writeFile(path.join(home, ".ssh", "id_ed25519"), "key");
  const device = files({ roots: [home] });
  expect(
    await device.run({
      type: "files.read",
      path: path.join(home, ".ssh", "id_ed25519"),
      encoding: "utf8",
      maxBytes: 1024,
    }),
  ).toMatchObject({ code: "protected_path" });
});

test("read-only access allows reads and refuses changes", async () => {
  const device = files({ access: "read" });
  const notes = path.join(shared, "notes.md");
  expect(
    await device.run({
      type: "files.read",
      path: notes,
      encoding: "utf8",
      maxBytes: 1024,
    }),
  ).toMatchObject({ data: "Buy milk\n" });
  expect(
    await device.run({
      type: "files.write",
      path: notes,
      data: "changed",
      encoding: "utf8",
    }),
  ).toMatchObject({ code: "read_only" });
  expect(await device.run({ type: "files.delete", path: notes })).toMatchObject(
    { code: "read_only" },
  );
  expect(await fs.readFile(notes, "utf8")).toBe("Buy milk\n");
});

test("turned-off file access refuses every operation", async () => {
  expect(
    await files({ access: "off" }).run({ type: "files.list", path: shared }),
  ).toMatchObject({ code: "files_disabled" });
});

test("reports binary and oversized files instead of returning garbled text", async () => {
  const image = path.join(shared, "photo.png");
  await fs.writeFile(image, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1]));
  const device = files();
  expect(
    await device.run({
      type: "files.read",
      path: image,
      encoding: "utf8",
      maxBytes: 1024,
    }),
  ).toMatchObject({ code: "binary_file" });
  expect(
    await device.run({
      type: "files.read",
      path: image,
      encoding: "base64",
      maxBytes: 1024,
    }),
  ).toMatchObject({ data: "iVBORwAB", size: 6 });
  expect(
    await device.run({
      type: "files.read",
      path: image,
      encoding: "base64",
      maxBytes: 2,
    }),
  ).toMatchObject({ code: "too_large" });
});

test("deletes files but not folders", async () => {
  const device = files();
  expect(
    await device.run({
      type: "files.delete",
      path: path.join(shared, "notes.md"),
    }),
  ).toEqual({ path: path.join(shared, "notes.md") });
  expect(
    await device.run({ type: "files.delete", path: shared }),
  ).toMatchObject({ code: "is_directory" });
});
