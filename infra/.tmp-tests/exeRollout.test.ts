import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";

const root = path.resolve(import.meta.dirname, "../..");
const script = path.join(root, "infra/workspace/exeRollout.sh");
const image = "halo-workspace:abc123";
const gib = 1024 ** 3;

let dir: string;
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

type Guest = {
  sizeGib: number;
  availGib: number;
  /** How many GiB the filesystem actually grows when exe.dev resizes the disk. */
  growsOnResize: boolean;
  imageBytes: number;
  images: string[];
};

// One stub binary dispatches every external command and records it, so the
// test observes the order of resize, load, upgrade and cleanup.
function run(guest: Guest) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "exe-rollout-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const state = path.join(dir, "guest.json");
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(state, JSON.stringify(guest));
  const manifest = path.join(dir, "release.json");
  fs.writeFileSync(
    manifest,
    JSON.stringify({ protocols: { workspace: { supported: [25, 26] } } }),
  );
  const stub = `#!${process.execPath}
const fs = require("node:fs");
const name = require("node:path").basename(process.argv[1]);
const args = process.argv.slice(2);
const line = [name, ...args].join(" ");
fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
const guest = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(guest));
const stdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
if (name === "gcloud") { console.log("token"); process.exit(0); }
if (name === "gzip") { process.stdout.write(stdin()); process.exit(0); }
if (name === "scp") process.exit(0);
if (name === "docker") {
  if (args[0] === "image" && args.includes("{{index .RepoDigests 0}}")) { console.log("registry/workspace-server@sha256:abc123"); process.exit(0); }
  if (args[0] === "image" && args.includes("{{.Size}}")) { console.log(String(guest.imageBytes)); process.exit(0); }
  if (args[0] === "save") { process.stdout.write("image-bytes"); process.exit(0); }
  process.exit(0);
}
if (name === "ssh") {
  const remote = args.slice(args.findIndex((a) => a === "exe.dev" || a.endsWith(".exe.xyz"))).join(" ");
  if (remote.startsWith("exe.dev ls")) { console.log(JSON.stringify({ vms: [{ status: "running" }] })); process.exit(0); }
  if (remote.startsWith("exe.dev resize")) {
    const target = Number(/--disk=(\\d+)GB/.exec(remote)[1]);
    if (guest.growsOnResize) { guest.availGib += target - guest.sizeGib; guest.sizeGib = target; save(); }
    process.exit(0);
  }
  if (remote.startsWith("exe.dev pause")) process.exit(0);
  if (remote.includes("--output=avail")) { console.log(" " + guest.availGib); process.exit(0); }
  if (remote.includes("--output=size")) { console.log(" " + guest.sizeGib); process.exit(0); }
  if (remote.includes("docker load")) { stdin(); guest.images.push(${JSON.stringify(image)}); save(); process.exit(0); }
  if (remote.includes("halo-workspace-upgrade")) process.exit(0);
  if (remote.includes("cli.ts status")) { console.log(JSON.stringify({ build: { revision: "rev" }, supportedProtocols: [25, 26] })); process.exit(0); }
  if (remote.includes("docker images")) {
    const stale = guest.images.filter((i) => i !== ${JSON.stringify(image)});
    for (const i of stale) fs.appendFileSync(${JSON.stringify(log)}, "removed " + i + "\\n");
    guest.images = guest.images.filter((i) => i === ${JSON.stringify(image)}); save();
    process.exit(0);
  }
  if (remote.includes("docker exec -i")) { stdin(); process.exit(0); }
  process.exit(0);
}
process.exit(0);
`;
  for (const name of ["ssh", "scp", "docker", "gcloud", "gzip", "sleep"]) {
    fs.writeFileSync(path.join(bin, name), stub, { mode: 0o755 });
  }
  const result = spawnSync("bash", [script, "update"], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      EXE_PRIVATE_KEY_PATH: "/dev/null",
      WORKSPACE_IMAGE: "registry/workspace-server@sha256:abc123",
      RUNNER_TEMP: dir,
      VERSION: "0.1.72",
      SOURCE_SHA: "rev",
      INSTANCE: "halo-vm",
      RELEASE_MANIFEST: manifest,
    },
  });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const index = (needle: string) => calls.findIndex((c) => c.includes(needle));
  return { result, calls, index };
}

test("a workspace with room loads, upgrades, and removes the previous image", () => {
  const { result, calls, index } = run({
    sizeGib: 100,
    availGib: 60,
    growsOnResize: true,
    imageBytes: Math.round(4.3 * gib),
    images: ["halo-workspace:old"],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(index("exe.dev resize")).toBe(-1);
  expect(index("docker load")).toBeLessThan(index("halo-workspace-upgrade"));
  expect(calls).toContain("removed halo-workspace:old");
  expect(index("removed halo-workspace:old")).toBeGreaterThan(index("cli.ts status"));
  expect(result.stdout).toContain(`HALO_WORKSPACE_READY image=${image}`);
  expect(result.stderr).not.toContain("Could not remove");
});

test("a 50 GB workspace grows to the 100 GB default before loading", () => {
  const { result, calls, index } = run({
    sizeGib: 50,
    availGib: 30,
    growsOnResize: true,
    imageBytes: Math.round(4.3 * gib),
    images: [],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(calls[index("exe.dev resize")]).toContain("--disk=100GB");
  expect(index("exe.dev resize")).toBeLessThan(index("docker load"));
});

test("a nearly full workspace grows by the shortfall", () => {
  // 5 GiB image needs 2 * 5 + 5 = 15 GiB free; 3 GiB free on 100 GiB grows to 112.
  const { result, calls, index } = run({
    sizeGib: 100,
    availGib: 3,
    growsOnResize: true,
    imageBytes: Math.round(4.3 * gib),
    images: ["halo-workspace:old"],
  });
  expect(result.status, result.stderr).toBe(0);
  expect(calls[index("exe.dev resize")]).toContain("--disk=112GB");
  expect(result.stdout).toContain("Growing halo-vm disk from 100GB to 112GB");
});

test("if growing does not free space, the running workspace is left untouched", () => {
  const { result, index } = run({
    sizeGib: 100,
    availGib: 3,
    growsOnResize: false,
    imageBytes: Math.round(4.3 * gib),
    images: ["halo-workspace:old"],
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "has 3GB free but needs 15GB to load halo-workspace:abc123; leaving the running workspace unchanged",
  );
  expect(index("docker load")).toBe(-1);
  expect(index("halo-workspace-upgrade")).toBe(-1);
});
