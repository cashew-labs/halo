import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import desktopPackage from "../electron/package.json";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig(({ mode }) => {
  return {
    plugins: [
      react(),
      {
        name: "halo-offline-shell",
        generateBundle(_options, bundle) {
          const worker = bundle["service-worker.js"];
          if (worker.type !== "chunk") return;
          const shell = new Set<string>();
          const addChunk = (name: string) => {
            if (shell.has(name)) return;
            shell.add(name);
            const chunk = bundle[name];
            if (chunk.type === "chunk") chunk.imports.forEach(addChunk);
          };
          // Offline launch needs the entry and its static imports, not every
          // lazy syntax-highlighting grammar or the cloud-only signed-in app.
          for (const file of Object.values(bundle)) {
            if (file.type === "chunk" && file.name === "index")
              addChunk(file.fileName);
            if (
              file.type === "asset" &&
              file.fileName.startsWith("assets/") &&
              !file.fileName.endsWith(".map")
            )
              shell.add(file.fileName);
          }
          const publicAssets = [
            "/manifest.json",
            "/icon-192.png",
            "/icon-512.png",
            "/icon-maskable-512.png",
          ];
          const assets = [
            "/index.html",
            ...publicAssets,
            ...[...shell].map((name) => `/${name}`),
          ];
          const version = crypto
            .createHash("sha256")
            .update(worker.code)
            .update(JSON.stringify(assets))
            .update(fs.readFileSync(new URL("./index.html", import.meta.url)));
          for (const asset of publicAssets)
            version.update(
              fs.readFileSync(new URL(`./public${asset}`, import.meta.url)),
            );
          worker.code = worker.code
            .replaceAll("haloPrecacheAssets", JSON.stringify(assets))
            .replaceAll(
              "haloCacheVersion",
              JSON.stringify(version.digest("hex")),
            );
        },
      },
    ],
    define: {
      "import.meta.env.VITE_HALO_VERSION": JSON.stringify(
        desktopPackage.version,
      ),
      "import.meta.env.VITE_HALO_DEVELOPMENT": mode !== "production",
    },
    // Bundled, unlike Electron: browsers download every module before first render.
    build: {
      minify: false,
      sourcemap: false,
      rolldownOptions: {
        input: {
          index: fileURLToPath(new URL("./index.html", import.meta.url)),
          serviceWorker: fileURLToPath(
            new URL("./src/serviceWorker.ts", import.meta.url),
          ),
        },
        output: {
          entryFileNames: (chunk) =>
            chunk.name === "serviceWorker"
              ? "service-worker.js"
              : "assets/[name]-[hash].js",
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
