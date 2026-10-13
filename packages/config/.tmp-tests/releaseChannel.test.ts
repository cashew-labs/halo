import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import {
  readReleaseChannel,
  writeReleaseChannel,
} from "../src/releaseChannel.js";

let dir: string;
let releaseChannelPath: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "release-channel-"));
  releaseChannelPath = path.join(dir, "release-channel");
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

test("a missing file selects production", () => {
  expect(readReleaseChannel(releaseChannelPath)).toBe("production");
});

test("staging round-trips and switching back removes the file", async () => {
  await writeReleaseChannel({ releaseChannelPath, releaseChannel: "staging" });
  expect(fs.readFileSync(releaseChannelPath, "utf8")).toBe("staging\n");
  expect(readReleaseChannel(releaseChannelPath)).toBe("staging");

  await writeReleaseChannel({
    releaseChannelPath,
    releaseChannel: "production",
  });
  expect(fs.existsSync(releaseChannelPath)).toBe(false);
  expect(readReleaseChannel(releaseChannelPath)).toBe("production");
});

test("switching to production without a saved channel succeeds", async () => {
  expect(
    await writeReleaseChannel({
      releaseChannelPath,
      releaseChannel: "production",
    }),
  ).toBeUndefined();
});

test("unknown contents are an error instead of a silent default", () => {
  fs.writeFileSync(releaseChannelPath, "beta\n");
  const result = readReleaseChannel(releaseChannelPath);
  expect(result).toBeInstanceOf(Error);
  expect((result as Error).message).toContain('"beta"');
});

test("an unreadable path is an error, not production", () => {
  fs.mkdirSync(releaseChannelPath);
  expect(readReleaseChannel(releaseChannelPath)).toBeInstanceOf(Error);
});

test("a failed write returns an error", async () => {
  const result = await writeReleaseChannel({
    releaseChannelPath: path.join(dir, "missing", "release-channel"),
    releaseChannel: "staging",
  });
  expect(result).toBeInstanceOf(Error);
});
