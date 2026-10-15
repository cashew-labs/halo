import { defineConfig } from "vitest/config";

const web = new URL("../../../", import.meta.url).pathname;

// Temp-test only: Maui ships extensionless ESM that Vite must bundle. The
// review runner sets the root to this folder, so coverage names the sources.
export default defineConfig({
  test: {
    environment: "jsdom",
    testTimeout: 30_000,
    server: { deps: { inline: [/maui/, /purse-styles/] } },
    coverage: { include: [`${web}src/**/*.{ts,tsx}`] },
  },
  resolve: { alias: { "node:fs": new URL("../../emptyNodeFs.ts", import.meta.url).pathname } },
});
