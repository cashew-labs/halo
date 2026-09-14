import { fileURLToPath } from "node:url";
import { haloWebHostPlugin } from "./forge/HaloWebHost.js";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const rendererPort = process.env.HALO_RENDERER_PORT;

export default defineConfig({
  plugins: [react(), haloWebHostPlugin()],
  build: {
    minify: false,
    sourcemap: false,
    // Vite 8 maps minify:false to Rolldown "dce-only". Keep that off too.
    rolldownOptions: {
      output: {
        minify: false,
      },
    },
  },
  optimizeDeps: {
    include: ["@pierre/diffs/react", "@pierre/diffs/edit"],
  },
  resolve: {
    alias: {
      // Tandem Logger.ts imports node:fs at module load.
      "node:fs": fileURLToPath(
        new URL("./src/renderer/emptyNodeFs.ts", import.meta.url),
      ),
    },
    dedupe: [
      "react",
      "react-dom",
      "react-aria-components",
      "purse-styles",
      "wouter",
    ],
    preserveSymlinks: false,
  },
  clearScreen: false,
  server: {
    allowedHosts: [".preview.niteshift.dev"],
    port: rendererPort === undefined ? 1420 : Number(rendererPort),
    strictPort: true,
  },
});
