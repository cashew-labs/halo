import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const reporter = fileURLToPath(
  new URL("./StreamingAgentReporter.ts", import.meta.url),
);

export default defineConfig({
  test: {
    reporters: [reporter],
  },
});
