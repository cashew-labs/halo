import { defineConfig } from "vitest/config";

// Temp-test only: Maui ships extensionless ESM that Vite must bundle.
export default defineConfig({
  test: { environment: "jsdom", server: { deps: { inline: [/maui/, /purse-styles/] } } },
  resolve: { alias: { "node:fs": new URL("../../emptyNodeFs.ts", import.meta.url).pathname } },
});
