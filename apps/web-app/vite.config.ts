import { fileURLToPath } from "node:url";
import desktopPackage from "../electron/package.json";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  const bundledDevelopment = mode === "bundled-development";
  return {
    plugins: [react()],
    define: {
      "import.meta.env.VITE_HALO_VERSION": JSON.stringify(
        desktopPackage.version,
      ),
      "import.meta.env.VITE_HALO_DEVELOPMENT": mode !== "production",
    },
    build: {
      minify: false,
      sourcemap: false,
      rolldownOptions: bundledDevelopment
        ? undefined
        : {
            output: {
              minify: false,
              preserveModules: true,
            },
          },
    },
    optimizeDeps: {
      include: ["maui", "maui/icons"],
    },
    resolve: {
      alias: {
        // Tandem Logger.ts imports node:fs at module load.
        "node:fs": fileURLToPath(
          new URL("../../packages/web/src/emptyNodeFs.ts", import.meta.url),
        ),
      },
      dedupe: [
        "react",
        "react-dom",
        "react-aria-components",
        "maui",
        "purse-styles",
        "wouter",
      ],
      preserveSymlinks: false,
    },
  };
});
