import fs from "node:fs";
import path from "node:path";
import process from "node:process";

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
  release.previousVersion === release.version
)
  fail("Release must identify the previous published frontend version");
const previous = JSON.parse(
  fs.readFileSync(`releases/${release.previousVersion}.json`, "utf8"),
);
// The last release before protocol-list bootstrapping spoke these exact protocols.
const previousProtocols =
  previous.protocols ??
  (previous.version === "0.1.52"
    ? {
        workspace: { client: 18, supported: [18] },
        controlPlane: { client: 3, supported: [3] },
      }
    : undefined);
if (previousProtocols === undefined)
  fail("Previous release has no verified protocol metadata");
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
  for (const protocol of new Set([
    current.client,
    ...previousProtocols[service].supported,
  ])) {
    if (!current.supported.includes(protocol))
      fail(
        `${service} must retain protocol ${protocol}; implement and test an adapter before advertising support`,
      );
  }
}

process.stdout.write(release.version);

function fail(message) {
  console.error(message);
  process.exit(1);
}
