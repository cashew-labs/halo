import { app, shell } from "electron";
import * as errore from "errore";

export class OpenExternalUrlError extends errore.createTaggedError({
  name: "OpenExternalUrlError",
  message: "Halo could not open the URL: $reason",
}) {}

export async function openExternalUrl(value: string) {
  const url = errore.try({
    try: () => new URL(value),
    catch: (cause) =>
      new OpenExternalUrlError({ reason: "the URL is invalid", cause }),
  });
  if (url instanceof Error) return url;
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return new OpenExternalUrlError({
      reason: `${url.protocol} URLs are not supported`,
    });
  }

  // E2E cannot finish Google OAuth. Opening the system browser leaves a child
  // that GitHub Actions cannot detach, so Playwright teardown never exits.
  if (process.env.HALO_E2E === "1") {
    app.emit("halo:e2e:open-external", url.toString());
    return;
  }

  return await shell
    .openExternal(url.toString())
    .catch(
      (cause) =>
        new OpenExternalUrlError({ reason: "the system rejected it", cause }),
    );
}
