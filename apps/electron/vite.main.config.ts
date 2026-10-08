import { builtinModules } from "node:module";
import { defineConfig } from "vite";
import { viteMainExternals } from "./forge/mainExternals.js";

const nodeBuiltins = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
];

export default defineConfig({
  build: {
    minify: false,
    // code-review-agent reads main-process coverage from source maps; emit them only for its builds.
    sourcemap: process.env.REVIEW_COVERAGE === "1",
    // Without platform:node, Rolldown replaces import.meta with {} for CJS
    // (EMPTY_IMPORT_META) and Pi/Halo crash on fileURLToPath({}.url).
    rolldownOptions: {
      platform: "node",
      external: [
        "electron",
        "electron/main",
        ...viteMainExternals(),
        ...nodeBuiltins,
      ],
      output: {
        minify: false,
        preserveModules: true,
      },
    },
    lib: {
      entry: "src/main/main.ts",
      // .cjs required: package.json has "type":"module", so .js is treated as ESM.
      fileName: () => "main.cjs",
      formats: ["cjs"],
    },
  },
});
