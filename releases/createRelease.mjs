import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";
import { compareVersions, createReleaseManifest } from "./releaseManifest.mjs";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "minimum-frontend": { type: "string" } },
});
const version = positionals[0];
if (version === undefined || positionals.length !== 1)
  fail("Usage: pnpm prerelease <version> [--minimum-frontend <version>]");
if (!/^\d+\.\d+\.\d+$/.test(version))
  fail(`Release version must use major.minor.patch: ${version}`);

const root = exec("git", ["rev-parse", "--show-toplevel"]);
process.chdir(root);

if (exec("git", ["branch", "--show-current"]) !== "main")
  fail("Run pnpm prerelease from main");
if (exec("git", ["status", "--porcelain"]) !== "")
  fail("Commit or stash local changes before creating a release");

run("git", ["fetch", "origin", "main", "--tags"]);
if (
  exec("git", ["rev-parse", "HEAD"]) !==
  exec("git", ["rev-parse", "origin/main"])
)
  fail("Local main must match origin/main");
if (exec("git", ["tag", "--list", version]) !== "")
  fail(`Tag ${version} already exists`);

const desktopPackagePath = path.join(root, "apps/electron/package.json");
const desktopPackage = JSON.parse(fs.readFileSync(desktopPackagePath, "utf8"));
if (compareVersions(version, desktopPackage.version) <= 0)
  fail(`${version} must be newer than ${desktopPackage.version}`);

const previousVersion = desktopPackage.version;
const previous = JSON.parse(
  fs.readFileSync(`releases/${previousVersion}.json`, "utf8"),
);
const protocols = JSON.parse(
  exec("pnpm", [
    "--silent",
    "--filter",
    "@get-halo/control-plane",
    "exec",
    "tsx",
    "../../releases/protocols.mjs",
  ]),
);
const release = createReleaseManifest({
  version,
  previous,
  protocols,
  minimumFrontendVersion: values["minimum-frontend"],
});
if (release instanceof Error) fail(release.message);

const releaseBranch = `release/${version}`;
run("git", ["switch", "-c", releaseBranch]);
desktopPackage.version = version;
fs.writeFileSync(
  desktopPackagePath,
  `${JSON.stringify(desktopPackage, undefined, 2)}\n`,
);

const pulumiConfigPath = path.join(
  root,
  "infra/control-plane/Pulumi.west.yaml",
);
let pulumiConfig = fs.readFileSync(pulumiConfigPath, "utf8");
pulumiConfig = replaceImage(
  pulumiConfig,
  "controlPlaneImage",
  `us-west2-docker.pkg.dev/halo-relay/halo-west-workspaces/control-plane:${version}`,
);
pulumiConfig = replaceImage(
  pulumiConfig,
  "workspaceImage",
  `us-west2-docker.pkg.dev/halo-relay/halo-west-workspaces/workspace-server:${version}`,
);
fs.writeFileSync(pulumiConfigPath, pulumiConfig);

const releaseDirectory = path.join(root, "releases");
const releasePath = path.join(releaseDirectory, `${version}.json`);
fs.mkdirSync(releaseDirectory, { recursive: true });
fs.writeFileSync(releasePath, `${JSON.stringify(release, undefined, 2)}\n`);

run("node", ["releases/validateRelease.mjs", releasePath]);
run("git", ["add", desktopPackagePath, pulumiConfigPath, releasePath]);
run("git", ["commit", "-m", `Release Halo ${version}`]);
run("git", ["push", "--set-upstream", "origin", releaseBranch]);
run("gh", [
  "pr",
  "create",
  "--base",
  "main",
  "--head",
  releaseBranch,
  "--title",
  `Release Halo ${version}`,
  "--body",
  [
    `Release Halo ${version}.`,
    "",
    "Merging this PR deploys production infrastructure, the control plane, and workspace servers before publishing the desktop release.",
  ].join("\n"),
]);

function replaceImage(contents, key, image) {
  const pattern = new RegExp(`^(  halo-control-plane:${key}: ).+$`, "m");
  if (!pattern.test(contents)) fail(`Pulumi config has no ${key}`);
  return contents.replace(pattern, `$1${image}`);
}

function exec(command, args) {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0)
    fail(`${command} exited with status ${String(result.status)}`);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
