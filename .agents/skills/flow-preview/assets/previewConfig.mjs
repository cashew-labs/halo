import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Kept separate from the browser entry so Node never loads React UI modules.
export function previewConfig({ directory, port }) {
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
        // Generated previews live in <project>/tmp/<name>. Allow real-component adapters.
        allow: [path.resolve(directory, "../..")],
      },
    },
  });
}
