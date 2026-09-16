import type { ForgeConfig } from "@electron-forge/shared-types";
import { copyMainProcessExternals } from "./forge/copyMainProcessExternals.js";
import { waitForDevelopmentServices } from "./forge/waitForDevelopmentServices.js";

const appleApiKey = process.env.APPLE_API_KEY;
const appleApiKeyId = process.env.APPLE_API_KEY_ID;
const appleApiIssuer = process.env.APPLE_API_ISSUER;
const shouldSign = process.env.npm_lifecycle_event !== "test:e2e:build";
const shouldNotarize =
  shouldSign &&
  appleApiKey !== undefined &&
  appleApiKeyId !== undefined &&
  appleApiIssuer !== undefined;

const packagerConfig: NonNullable<ForgeConfig["packagerConfig"]> = {
  asar: true,
  appBundleId: "com.saffronhealth.halo",
  appCategoryType: "public.app-category.medical",
  icon: "icons/icon",
  name: "Halo",
  executableName: "Halo",
};
if (shouldSign) {
  packagerConfig.osxSign = {};
}
if (shouldNotarize) {
  packagerConfig.osxNotarize = {
    appleApiKey,
    appleApiKeyId,
    appleApiIssuer,
  };
}

const config: ForgeConfig = {
  packagerConfig,
  rebuildConfig: {
    // @parcel/watcher ships N-API prebuilds. Rebuilding from source fails on
    // windows-latest (VS 2026 / node-gyp) and downloads Electron headers from GitHub.
    ignoreModules: ["@parcel/watcher"],
  },
  hooks: {
    preStart: async () => {
      const ready = await waitForDevelopmentServices();
      if (ready instanceof Error) throw ready;
    },
    packageAfterCopy: async (_forgeConfig, buildPath) => {
      await copyMainProcessExternals(buildPath);
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-squirrel",
      platforms: ["win32"],
      config: {
        name: "Halo",
        authors: "Saffron Health",
        description: "Halo desktop app",
      },
    },
    {
      name: "@electron-forge/maker-zip",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-dmg",
      platforms: ["darwin"],
      config: {},
    },
    {
      name: "@electron-forge/maker-deb",
      platforms: ["linux"],
      config: {
        options: {
          name: "halo",
          bin: "Halo",
          productName: "Halo",
        },
      },
    },
    {
      name: "@electron-forge/maker-rpm",
      platforms: ["linux"],
      config: {
        options: {
          name: "halo",
          bin: "Halo",
          productName: "Halo",
          license: "MIT",
        },
      },
    },
  ],
  publishers: [
    {
      name: "@electron-forge/publisher-github",
      config: {
        repository: {
          owner: "cashew-labs",
          name: "halo",
        },
        prerelease: false,
        draft: false,
        // Tag must equal package.json version (no "v" prefix).
        tagPrefix: "",
      },
    },
  ],
  plugins: [
    {
      name: "@electron-forge/plugin-auto-unpack-natives",
      config: {},
    },
    {
      name: "@electron-forge/plugin-vite",
      config: {
        build: [
          {
            entry: "src/main/main.ts",
            config: "vite.main.config.ts",
          },
          {
            entry: "src/main/preload.ts",
            config: "vite.preload.config.ts",
          },
        ],
        renderer: [
          {
            name: "main_window",
            config: "vite.renderer.config.ts",
          },
        ],
      },
    },
  ],
};

export default config;
