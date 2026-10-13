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
  status: "running" | "paused";
  availGib: number;
  imageBytes: number;
  /** Images on the guest; `configured` is what /etc/halo/image names. */
  images: string[];
  configured: string;
  /** Images used by containers, running or stopped. */
  containers?: string[];
  upgradeFails?: boolean;
  neverReady?: boolean;
};

// One stub binary stands in for every external command and records each call,
// so the tests observe the order of cleanup, load, upgrade and pause.
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
const record = (line) => fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
record([name, ...args].join(" "));
const guest = JSON.parse(fs.readFileSync(${JSON.stringify(state)}, "utf8"));
const save = () => fs.writeFileSync(${JSON.stringify(state)}, JSON.stringify(guest));
const stdin = () => { try { return fs.readFileSync(0, "utf8"); } catch { return ""; } };
if (name === "gcloud") { console.log("token"); process.exit(0); }
if (name === "gzip") { process.stdout.write(stdin()); process.exit(0); }
if (name === "scp") process.exit(0);
if (name === "docker" && process.env.HALO_TEST_GUEST) {
  const containers = guest.containers ?? [];
  // Entries ending in "@stopped" are listed only with -a, like docker ps.
  if (args[0] === "ps") { containers.forEach((c, i) => { if (args.some((a) => a.includes("a")) || !c.endsWith("@stopped")) console.log("c" + i); }); process.exit(0); }
  if (args[0] === "inspect") { for (const id of args.filter((a) => /^c\\d+$/.test(a))) console.log(containers[Number(id.slice(1))].replace("@stopped", "")); process.exit(0); }
  if (args[0] === "images") { for (const i of guest.images) console.log(i); process.exit(0); }
  if (args[0] === "rmi") {
    const target = args[args.length - 1];
    if (containers.some((c) => c.replace("@stopped", "") === target)) { console.error("image is in use"); process.exit(1); }
    guest.images = guest.images.filter((i) => i !== target); save();
    record("removed " + target + " while " + guest.status); process.exit(0);
  }
  process.exit(0);
}
if (name === "docker") {
  if (args[0] === "image" && args.includes("{{index .RepoDigests 0}}")) { console.log("registry/workspace-server@sha256:abc123"); process.exit(0); }
  if (args[0] === "image" && args.includes("{{.Size}}")) { console.log(String(guest.imageBytes)); process.exit(0); }
  if (args[0] === "save") { process.stdout.write("image-bytes"); process.exit(0); }
  process.exit(0);
}
if (name === "ssh") {
  const remote = args.slice(args.findIndex((a) => a === "exe.dev" || a.endsWith(".exe.xyz"))).join(" ");
  if (remote.startsWith("exe.dev ls")) { console.log(JSON.stringify({ vms: [{ status: guest.status }] })); process.exit(0); }
  if (remote.startsWith("exe.dev resume")) { guest.status = "running"; save(); process.exit(0); }
  if (remote.startsWith("exe.dev pause")) { guest.status = "paused"; save(); process.exit(0); }
  if (remote.includes("bash -s")) {
    // Run the script's real guest-side cleanup against the stubbed docker.
    const configured = ${JSON.stringify(path.join("__DIR__", "etc-halo-image"))}.replace("__DIR__", process.env.HALO_TEST_DIR);
    fs.writeFileSync(configured, guest.configured + "\\n");
    const body = stdin().replaceAll("/etc/halo/image", configured);
    const run = require("node:child_process").spawnSync("bash", ["-c", body], {
      stdio: ["ignore", "inherit", "inherit"],
      env: { ...process.env, HALO_TEST_GUEST: "1" },
    });
    process.exit(run.status ?? 1);
  }
  if (remote.includes("--output=avail")) { console.log(" " + guest.availGib); process.exit(0); }
  if (remote.includes("docker load")) { stdin(); guest.images.push(${JSON.stringify(image)}); save(); process.exit(0); }
  if (remote.includes("halo-workspace-upgrade")) {
    if (guest.upgradeFails) process.exit(1);
    guest.configured = ${JSON.stringify(image)};
    guest.containers = [${JSON.stringify(image)}]; save(); process.exit(0);
  }
  if (remote.includes("cli.ts status")) { console.log(JSON.stringify({ build: { revision: guest.neverReady ? "old" : "rev" }, supportedProtocols: [25, 26] })); process.exit(0); }
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
      HALO_TEST_DIR: dir,
    },
  });
  const calls = fs.readFileSync(log, "utf8").trim().split("\n");
  const index = (needle: string) => calls.findIndex((c) => c.includes(needle));
  const final = JSON.parse(fs.readFileSync(state, "utf8")) as Guest;
  return { result, calls, index, final };
}

const old = "halo-workspace:old";
const leftover = "halo-workspace:failed-earlier";
const fourGib = Math.round(4.3 * gib);

test("an update clears leftovers first, then keeps only the new release", () => {
  const { result, calls, index, final } = run({
    status: "running",
    availGib: 30,
    imageBytes: fourGib,
    images: [old, leftover],
    configured: old,
  });
  expect(result.status, result.stderr).toBe(0);
  // A leftover from an earlier failed install is removed before the transfer.
  expect(index(`removed ${leftover}`)).toBeLessThan(index("docker load"));
  // The previous release is removed only after the new one reports ready.
  expect(index(`removed ${old}`)).toBeGreaterThan(index("cli.ts status"));
  expect(final.images).toEqual([image]);
  expect(calls.some((c) => c.includes("exe.dev resize"))).toBe(false);
  expect(result.stdout).toContain(`HALO_WORKSPACE_READY image=${image}`);
});

test("a paused workspace is cleaned while awake and paused again afterwards", () => {
  const { result, index, final } = run({
    status: "paused",
    availGib: 30,
    imageBytes: fourGib,
    images: [old],
    configured: old,
  });
  expect(result.status, result.stderr).toBe(0);
  expect(index(`removed ${old} while running`)).toBeGreaterThan(-1);
  expect(index(`removed ${old}`)).toBeLessThan(index("exe.dev pause"));
  expect(final.status).toBe("paused");
});

test("without room for the image, nothing is transferred and the workspace keeps running", () => {
  const { result, calls, index, final } = run({
    status: "running",
    availGib: 3,
    imageBytes: fourGib,
    images: [old],
    configured: old,
  });
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(
    "has 3GB free but needs 15GB to load halo-workspace:abc123; leaving the running workspace unchanged",
  );
  expect(index("docker load")).toBe(-1);
  expect(index("halo-workspace-upgrade")).toBe(-1);
  expect(calls.some((c) => c.includes("exe.dev resize"))).toBe(false);
  expect(final.images).toEqual([old]);
});

test("an image that fails to install is removed and the running release is kept", () => {
  const { result, final } = run({
    status: "running",
    availGib: 30,
    imageBytes: fourGib,
    images: [old],
    configured: old,
    upgradeFails: true,
  });
  expect(result.status).not.toBe(0);
  expect(final.images).toEqual([old]);
  expect(final.configured).toBe(old);
});

test("a paused workspace whose update fails is cleaned while awake and paused again", () => {
  const { result, index, final } = run({
    status: "paused",
    availGib: 30,
    imageBytes: fourGib,
    images: [old],
    configured: old,
    upgradeFails: true,
  });
  expect(result.status).not.toBe(0);
  expect(index(`removed ${image} while running`)).toBeGreaterThan(-1);
  expect(index(`removed ${image}`)).toBeLessThan(index("exe.dev pause"));
  expect(final.status).toBe("paused");
  expect(final.images).toEqual([old]);
});

test("cleanup keeps the configured image and images any container uses, even a stopped one", () => {
  const stopped = "halo-workspace:stopped-container";
  const { result, final } = run({
    status: "running",
    availGib: 30,
    imageBytes: fourGib,
    images: [old, stopped, leftover],
    configured: old,
    containers: [old, `${stopped}@stopped`],
    upgradeFails: true,
  });
  expect(result.status).not.toBe(0);
  // The failed install and the unused leftover go; configured and in-use stay.
  expect(final.images.sort()).toEqual([old, stopped].sort());
});

test("when readiness fails after the switch, the new configured image is kept", () => {
  const { result, final } = run({
    status: "running",
    availGib: 30,
    imageBytes: fourGib,
    images: [old],
    configured: old,
    neverReady: true,
  });
  expect(result.status).not.toBe(0);
  expect(final.configured).toBe(image);
  expect(final.images).toEqual([image]);
  // The script polls readiness 60 times; each poll starts two stub processes.
}, 60_000);
