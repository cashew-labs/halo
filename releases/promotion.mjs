import { compareVersions } from "./releaseManifest.mjs";

export const productionConfigPath = "infra/control-plane/Pulumi.prod.yaml";
export const stagingRepository = "cashew-labs/halo-staging";

const imageRoot = "us-west2-docker.pkg.dev/halo-relay/halo-west-workspaces";

/** Checks that `release` can replace the version production runs now. */
export function validatePromotion({ release, production }) {
  if (production === undefined) return undefined;
  if (compareVersions(release.version, production.version) <= 0)
    return new Error(
      `${release.version} must be newer than production ${production.version}`,
    );
  // Production may skip staging releases, but the new backend must still
  // serve the desktop and browser clients production users have now.
  if (compareVersions(production.version, release.minimumFrontendVersion) < 0)
    return new Error(
      `${release.version} supports frontends from ${release.minimumFrontendVersion}, but production runs ${production.version}`,
    );
  return undefined;
}

/** The exe.dev template VM the staging deployment of `version` created. */
export function exeTemplateVmName(version) {
  return `halo-exe-${version.replaceAll(".", "-")}`;
}

/** Pins the production stack to the images and template staging verified. */
export function pinProductionConfig(contents, version) {
  let pinned = contents;
  for (const [key, value] of [
    ["controlPlaneImage", `${imageRoot}/control-plane:${version}`],
    ["workspaceImage", `${imageRoot}/workspace-server:${version}`],
    ["exeTemplateVmName", exeTemplateVmName(version)],
  ]) {
    const pattern = new RegExp(`^(  halo-control-plane:${key}: ).+$`, "m");
    if (!pattern.test(pinned))
      return new Error(`Production Pulumi config has no ${key}`);
    pinned = pinned.replace(pattern, `$1${value}`);
  }
  return pinned;
}

/** Reads the source revision the staging release workflow records in its notes. */
export function stagingSourceRevision(notes) {
  const match = /^Source: cashew-labs\/halo@([0-9a-f]{40})$/m.exec(notes);
  if (match === null)
    return new Error("Staging release notes do not name a source revision");
  return match[1];
}

export function stagingReleaseNotes(revision) {
  return `Source: cashew-labs/halo@${revision}`;
}
