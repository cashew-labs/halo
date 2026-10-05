import fs from "node:fs/promises";

await fs.mkdir(new URL("./dist/", import.meta.url), { recursive: true });
await fs.copyFile(
  new URL("./server.mjs", import.meta.url),
  new URL("./dist/start.mjs", import.meta.url),
);
