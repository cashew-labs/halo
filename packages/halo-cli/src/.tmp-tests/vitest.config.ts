import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    server: {
      deps: {
        inline: [
          "@tanishqkancharla/tandem-core",
          "@tanishqkancharla/tandem-server",
        ],
      },
    },
  },
});
