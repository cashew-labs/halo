import { defineConfig } from "vite";

export default defineConfig({
  build: {
    minify: false,
    // code-review-agent builds with REVIEW_COVERAGE=1 to map coverage back to src/.
    sourcemap: process.env.REVIEW_COVERAGE === "1",
    rolldownOptions: {
      external: ["electron/renderer"],
      output: {
        minify: false,
      },
    },
  },
});
