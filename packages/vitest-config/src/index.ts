import { defineConfig } from "vitest/config";
import StreamingAgentReporter from "./StreamingAgentReporter.js";

export default defineConfig({
  test: {
    reporters: [new StreamingAgentReporter()],
  },
});
