import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environmentOptions: {
      happyDOM: {
        settings: {
          disableJavaScriptFileLoading: true,
          handleDisabledFileLoadingAsSuccess: true,
        },
      },
    },
    server: {
      deps: {
        // Maui and Tandem publish extensionless ESM imports, resolved by the app bundler.
        inline: ["maui", "purse-styles", "@tanishqkancharla/tandem-core"],
      },
    },
  },
});
