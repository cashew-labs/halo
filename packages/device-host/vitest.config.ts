import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // Tandem 0.3.0 ships extensionless ESM imports; transform them as the
        // workspace host's tsx loader and frontend bundler do.
        inline: ["@tanishqkancharla/tandem-core"],
      },
    },
  },
});
