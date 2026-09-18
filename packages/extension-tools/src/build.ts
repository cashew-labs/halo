import { randomUUID } from "node:crypto";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { build } from "esbuild";
import * as errore from "errore";

class ExtensionBuildError extends errore.createTaggedError({
  name: "ExtensionBuildError",
  message: "Extension build failed: $step",
}) {}

export async function buildExtension(directory: string) {
  const buildId = randomUUID();
  const dist = join(directory, "dist");
  const output = join(dist, buildId);
  const created = await mkdir(output, { recursive: true }).catch(
    (cause) => new ExtensionBuildError({ step: "create output", cause }),
  );
  if (created instanceof Error) return created;
  let published = false;
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    if (published) return;
    const removed = await rm(output, { recursive: true, force: true }).catch(
      (cause) =>
        new ExtensionBuildError({ step: "clean failed output", cause }),
    );
    if (removed instanceof Error) console.warn(removed);
  });
  const [view, server] = await Promise.all([
    build({
      absWorkingDir: directory,
      bundle: true,
      format: "esm",
      platform: "browser",
      jsx: "automatic",
      logLevel: "silent",
      metafile: true,
      stdin: {
        resolveDir: directory,
        loader: "tsx",
        contents: `
import { createRoot } from "react-dom/client";
import { connectExtension } from "@get-halo/extension-sdk/client";
import View from "./view.tsx";
import { relations, schema } from "./schema.ts";
const client = await connectExtension({ schema, relations });
if (client instanceof Error) throw client;
createRoot(document.getElementById("root")).render(<View {...client} />);`,
      },
      outfile: join(output, "public", "view.js"),
      loader: {
        ".svg": "file",
        ".png": "file",
        ".jpg": "file",
        ".webp": "file",
        ".woff": "file",
        ".woff2": "file",
      },
    }).catch(
      (cause) => new ExtensionBuildError({ step: "compile view", cause }),
    ),
    build({
      absWorkingDir: directory,
      bundle: true,
      format: "esm",
      platform: "node",
      target: "node22",
      logLevel: "silent",
      stdin: {
        resolveDir: directory,
        contents: `
import { fileURLToPath } from "node:url";
import { runExtension } from "@get-halo/extension-sdk/server";
import router from "./api.ts";
await runExtension({ router, publicDirectory: fileURLToPath(new URL("./public/", import.meta.url)) });`,
      },
      outfile: join(output, "server.mjs"),
    }).catch(
      (cause) => new ExtensionBuildError({ step: "compile api", cause }),
    ),
  ]);
  if (view instanceof Error) return view;
  if (server instanceof Error) return server;
  const css = Object.values(view.metafile.outputs).some(
    (file) => file.cssBundle !== undefined,
  );
  const html = `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <script>
      (() => {
        const viewPath = "/view/";
        const viewEnd = location.pathname.lastIndexOf(viewPath) + viewPath.length;
        const base = document.createElement("base");
        base.href = location.pathname.slice(0, viewEnd);
        document.head.append(base);
      })();
    </script>
    ${css ? '<link rel="stylesheet" href="./assets/view.css">' : ""}
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./assets/view.js"></script>
  </body>
</html>`;
  const files = [
    [join(output, "public", "index.html"), html],
    [
      join(dist, "start.mjs"),
      `import { readFile } from "node:fs/promises";
const buildId = JSON.parse(await readFile(new URL("./current.json", import.meta.url), "utf8"));
await import(new URL(buildId + "/server.mjs", import.meta.url));\n`,
    ],
    [join(output, "current.json"), JSON.stringify(buildId)],
  ] as const;
  for (const [path, source] of files) {
    const written = await writeFile(path, source).catch(
      (cause) => new ExtensionBuildError({ step: "write artifacts", cause }),
    );
    if (written instanceof Error) return written;
  }
  const committed = await rename(
    join(output, "current.json"),
    join(dist, "current.json"),
  ).catch((cause) => new ExtensionBuildError({ step: "publish build", cause }));
  if (committed instanceof Error) return committed;
  published = true;
  return { buildId };
}
