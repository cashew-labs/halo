import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  workers: 1,
  outputDir: "../../tmp/marketing-web-results",
  use: {
    baseURL: "http://127.0.0.1:4176",
    browserName: "chromium",
  },
  webServer: {
    command:
      "pnpm exec vite build --mode bundled-development --sourcemap --outDir ../../tmp/marketing-web-test && node test/configureAnalytics.mjs && pnpm exec vite preview --outDir ../../tmp/marketing-web-test --host 127.0.0.1 --port 4176 --strictPort",
    url: "http://127.0.0.1:4176",
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
