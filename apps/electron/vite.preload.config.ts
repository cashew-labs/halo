import { defineConfig } from "vite";

export default defineConfig({
  build: {
    minify: false,
    rolldownOptions: {
      external: ["electron/renderer"],
      output: {
        minify: false,
      },
    },
  },
});
