import { defineConfig } from "vite";

export default defineConfig({
  build: {
    minify: false,
    // code-review-agent reads preload coverage from source maps; emit them only for its builds.
    sourcemap: process.env.REVIEW_COVERAGE === "1",
    rolldownOptions: {
      external: ["electron/renderer"],
      output: {
        minify: false,
      },
    },
  },
});
