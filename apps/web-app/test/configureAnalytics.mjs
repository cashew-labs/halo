import { readFile, writeFile } from "node:fs/promises";

// Configure the built test artifact as the production HTTP server does.
const index = new URL(
  "../../../tmp/marketing-web-test/index.html",
  import.meta.url,
);
const html = await readFile(index, "utf8");
await writeFile(
  index,
  html.replace(
    'name="halo-ga-measurement-id" content=""',
    'name="halo-ga-measurement-id" content="G-HALOTEST"',
  ),
);
