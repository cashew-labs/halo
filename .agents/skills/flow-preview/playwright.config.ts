import path from "node:path";
import url from "node:url";
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  outputDir: path.join(
    url.fileURLToPath(new URL("./", import.meta.url)),
    "tmp/test-results",
  ),
  workers: 1,
  use: {
    viewport: { width: 1460, height: 1000 },
    deviceScaleFactor: 2,
    launchOptions: {
      executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    },
  },
});
