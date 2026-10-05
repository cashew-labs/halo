export function createReleaseManifest({
  version,
  previous,
  protocols,
  minimumFrontendVersion: requestedMinimum,
}) {
  // The first protocol-list release intentionally retires 0.1.52 (protocol 17).
  const minimumFrontendVersion =
    requestedMinimum ??
    previous.minimumFrontendVersion ??
    (previous.version === "0.1.52" ? version : undefined);
  if (minimumFrontendVersion === undefined)
    return new Error("Previous release has no minimum supported frontend");
  return {
    version,
    previousVersion: previous.version,
    minimumFrontendVersion,
    protocols,
  };
}

export function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < leftParts.length; index += 1) {
    const difference = leftParts[index] - rightParts[index];
    if (difference !== 0) return difference;
  }
  return 0;
}
