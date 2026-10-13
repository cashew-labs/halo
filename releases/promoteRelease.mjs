import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  pinProductionConfig,
  productionConfigPath,
  stagingRepository,
  validatePromotion,
} from "./promotion.mjs";

const [version, ...extra] = process.argv.slice(2);
if (version === undefined || extra.length > 0)
  fail("Usage: pnpm promote <version>");

const root = exec("git", ["rev-parse", "--show-toplevel"]);
process.chdir(root);

if (exec("git", ["branch", "--show-current"]) !== "main")
  fail("Run pnpm promote from main");
if (exec("git", ["status", "--porcelain"]) !== "")
  fail("Commit or stash local changes before promoting a release");
run("git", ["fetch", "origin", "main"]);
if (
  exec("git", ["rev-parse", "HEAD"]) !==
  exec("git", ["rev-parse", "origin/main"])
)
  fail("Local main must match origin/main");

const releasePath = path.join("releases", `${version}.json`);
if (!fs.existsSync(releasePath))
  fail(`${releasePath} does not exist; release ${version} to staging first`);
const staging = JSON.parse(
  exec("gh", [
    "release",
    "view",
    version,
    "--repo",
    stagingRepository,
    "--json",
    "isDraft",
  ]),
);
if (staging.isDraft)
  fail(`Staging release ${version} is still a draft; wait for it to publish`);

const productionPath = path.join("releases", "production.json");
const production = fs.existsSync(productionPath)
  ? JSON.parse(fs.readFileSync(productionPath, "utf8"))
  : undefined;
const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
const invalid = validatePromotion({ release, production });
if (invalid instanceof Error) fail(invalid.message);

const pinned = pinProductionConfig(
  fs.readFileSync(productionConfigPath, "utf8"),
  version,
);
if (pinned instanceof Error) fail(pinned.message);

const branch = `promote/${version}`;
run("git", ["switch", "-c", branch]);
fs.writeFileSync(productionConfigPath, pinned);
fs.writeFileSync(
  productionPath,
  `${JSON.stringify({ version }, undefined, 2)}\n`,
);
run("node", ["releases/validatePromotion.mjs", productionPath]);
run("git", ["add", productionConfigPath, productionPath]);
run("git", ["commit", "-m", `Promote Halo ${version} to production`]);
run("git", ["push", "--set-upstream", "origin", branch]);
run("gh", [
  "pr",
  "create",
  "--base",
  "main",
  "--head",
  branch,
  "--title",
  `Promote Halo ${version} to production`,
  "--body",
  [
    `Promote Halo ${version} from staging to production.`,
    "",
    "Merging this PR deploys the images staging verified to the prod stack, updates production workspace VMs, and copies the signed desktop release from cashew-labs/halo-staging to cashew-labs/halo.",
  ].join("\n"),
]);

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
