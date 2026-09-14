import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const releasePath = process.argv[2];
if (releasePath === undefined)
  fail("Usage: node scripts/validateRelease.mjs <release.json>");

const release = JSON.parse(fs.readFileSync(releasePath, "utf8"));
if (!/^\d+\.\d+\.\d+$/.test(release.version))
  fail(`Release version must use major.minor.patch: ${release.version}`);
if (path.basename(releasePath) !== `${release.version}.json`)
  fail("Release filename must match its version");

const desktopPackage = JSON.parse(
  fs.readFileSync("apps/electron/package.json", "utf8"),
);
if (desktopPackage.version !== release.version)
  fail("Desktop package version must match the release version");

const pulumiConfig = fs.readFileSync(
  "infra/control-plane/Pulumi.west.yaml",
  "utf8",
);
for (const image of ["control-plane", "workspace-server"]) {
  const reference = `us-west2-docker.pkg.dev/halo-relay/halo-west-workspaces/${image}:${release.version}`;
  if (!pulumiConfig.includes(reference))
    fail(`Pulumi config must reference ${reference}`);
}

process.stdout.write(release.version);

function fail(message) {
  console.error(message);
  process.exit(1);
}
