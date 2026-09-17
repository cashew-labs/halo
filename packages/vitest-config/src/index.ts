import { defineConfig } from "vitest/config";
import StreamingAgentReporter from "./StreamingAgentReporter.ts";

export default defineConfig({
  test: {
    reporters: [new StreamingAgentReporter()],
  },
});
