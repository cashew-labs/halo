import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // Tandem 0.3.0 ships extensionless ESM imports. Transform them as the
        // workspace host's tsx loader and the extension bundler already do.
        inline: [
          "@tanishqkancharla/tandem-core",
          "@tanishqkancharla/tandem-server",
        ],
      },
    },
  },
});
