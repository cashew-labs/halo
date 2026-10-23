import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Kept separate from the browser entry so Node never loads React UI modules.
export function previewConfig({ directory, port, sourceRoots = [] }) {
  return defineConfig({
    root: directory,
    plugins: [react()],
    resolve: {
      dedupe: [
        "react",
        "react-dom",
        "react-aria-components",
        "maui",
        "purse-styles",
        "motion",
      ],
    },
    server: {
      host: "0.0.0.0",
      port,
      strictPort: true,
      allowedHosts: true,
      fs: {
        allow: [
          directory,
          ...sourceRoots.map((root) => path.resolve(directory, root)),
        ],
        deny: [
          "**/.env",
          "**/.env.*",
          "**/*.{crt,pem,key}",
          "**/.git/**",
          "**/.halo/**",
          "**/.amp/**",
        ],
      },
    },
  });
}
