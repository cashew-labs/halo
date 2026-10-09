import fs from "node:fs";
import fsPromises from "node:fs/promises";
import * as errore from "errore";

/** Packaged builds connect to one deployment and update from its release repository. */
export type ReleaseChannel = "production" | "staging";

class ReleaseChannelError extends errore.createTaggedError({
  name: "ReleaseChannelError",
  message: "Release channel $detail",
}) {}

/** Reads the channel saved at `releaseChannelPath`; a missing file means production. */
export function readReleaseChannel(
  releaseChannelPath: string,
): ReleaseChannel | Error {
  const contents = errore.try({
    try: () => fs.readFileSync(releaseChannelPath, "utf8"),
    catch: (cause) => new ReleaseChannelError({ detail: "read failed", cause }),
  });
  if (contents instanceof Error)
    return isMissingFile(contents.cause) ? "production" : contents;

  const releaseChannel = contents.trim();
  if (releaseChannel === "production" || releaseChannel === "staging")
    return releaseChannel;
  return new ReleaseChannelError({
    detail: `"${releaseChannel}" in ${releaseChannelPath} is unknown`,
  });
}

/** Saves the channel that the next launch reads. */
export async function writeReleaseChannel(ctx: {
  releaseChannelPath: string;
  releaseChannel: ReleaseChannel;
}): Promise<void | Error> {
  const written =
    ctx.releaseChannel === "production"
      ? fsPromises.rm(ctx.releaseChannelPath, { force: true })
      : fsPromises.writeFile(ctx.releaseChannelPath, `${ctx.releaseChannel}\n`);
  return await written.catch(
    (cause) =>
      new ReleaseChannelError({
        detail: `${ctx.releaseChannel} could not be saved`,
        cause,
      }),
  );
}

function isMissingFile(cause: unknown) {
  return cause instanceof Error && "code" in cause && cause.code === "ENOENT";
}
