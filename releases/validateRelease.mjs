import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { compareVersions } from "./releaseManifest.mjs";

const releasePath = process.argv[2];
if (releasePath === undefined)
  fail("Usage: node releases/validateRelease.mjs <release.json>");

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

if (
  !/^\d+\.\d+\.\d+$/.test(release.previousVersion) ||
  compareVersions(release.previousVersion, release.version) >= 0
)
  fail("Release must identify the previous published frontend version");
const previous = JSON.parse(
  fs.readFileSync(`releases/${release.previousVersion}.json`, "utf8"),
);
if (previous.version !== release.previousVersion)
  fail("Previous release filename must match its version");

const minimum = release.minimumFrontendVersion;
if (
  !/^\d+\.\d+\.\d+$/.test(minimum) ||
  compareVersions(minimum, release.version) > 0
)
  fail("Release must identify a valid minimum supported frontend version");

const supportedFrontends = fs
  .readdirSync("releases")
  .filter((file) => /^\d+\.\d+\.\d+\.json$/.test(file))
  .map((file) => file.slice(0, -5))
  .filter(
    (version) =>
      compareVersions(version, minimum) >= 0 &&
      compareVersions(version, release.version) < 0,
  )
  .sort(compareVersions)
  .map((version) => {
    const frontend = JSON.parse(
      fs.readFileSync(`releases/${version}.json`, "utf8"),
    );
    if (frontend.version !== version)
      fail(`Release ${version} filename must match its version`);
    return frontend;
  });
supportedFrontends.push(release);
if (!supportedFrontends.some((frontend) => frontend.version === minimum))
  fail("Minimum supported frontend must identify a release manifest");

for (const service of ["workspace", "controlPlane"]) {
  const current = release.protocols?.[service];
  if (
    !Number.isSafeInteger(current?.client) ||
    current.client < 1 ||
    !Array.isArray(current.supported) ||
    current.supported.length === 0 ||
    !current.supported.every(
      (value) => Number.isSafeInteger(value) && value > 0,
    )
  )
    fail(`Invalid ${service} protocols`);
  for (const frontend of supportedFrontends) {
    // Verified against tag 0.1.52, before release manifests recorded protocols.
    const protocols =
      frontend.protocols ??
      (frontend.version === "0.1.52"
        ? { workspace: { client: 17 }, controlPlane: { client: 3 } }
        : undefined);
    const required = protocols?.[service]?.client;
    if (!Number.isSafeInteger(required) || required < 1)
      fail(
        `Release ${frontend.version} has no valid ${service} client protocol`,
      );
    if (!current.supported.includes(required))
      fail(
        `${service} must support protocol ${required} for frontend ${frontend.version}; implement compatibility or raise minimumFrontendVersion`,
      );
  }
}

process.stdout.write(release.version);

function fail(message) {
  console.error(message);
  process.exit(1);
}
