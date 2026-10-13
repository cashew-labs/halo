import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    server: {
      deps: {
        // Tandem 0.3.0 uses extensionless ESM imports; the extension bundler
        // resolves them, and the test runner must transform the same modules.
        inline: [
          "@tanishqkancharla/tandem-core",
          "@tanishqkancharla/tandem-server",
        ],
      },
    },
  },
});
