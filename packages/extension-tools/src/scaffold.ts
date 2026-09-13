import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as errore from "errore";

class ExtensionScaffoldError extends errore.createTaggedError({
  name: "ExtensionScaffoldError",
  message: "Could not scaffold extension in '$directory'",
}) {}

export async function scaffoldExtension(args: {
  directory: string;
  name: string;
  packages?: { sdk: string; tools: string };
}) {
  const packages =
    args.packages === undefined
      ? { sdk: "0.1.0", tools: "0.1.0" }
      : args.packages;
  const created = await mkdir(args.directory).catch(
    (cause) => new ExtensionScaffoldError({ directory: args.directory, cause }),
  );
  if (created instanceof Error) return created;
  const files = {
    "package.json": JSON.stringify(
      {
        name: args.name,
        private: true,
        type: "module",
        scripts: {
          build: "halo-extension build",
          start: "node dist/start.mjs",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          "@get-halo/extension-sdk": packages.sdk,
          react: "^19.2.8",
          "react-dom": "^19.2.8",
          maui: "npm:@tanishqkancharla/maui@0.0.19",
          errore: "^0.14.1",
        },
        devDependencies: {
          "@get-halo/extension-tools": packages.tools,
          "@types/react": "19.2.18",
          typescript: "7.0.2",
        },
      },
      undefined,
      2,
    ),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          lib: ["ESNext", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "Bundler",
          jsx: "react-jsx",
          strict: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["*.ts", "*.tsx"],
      },
      undefined,
      2,
    ),
    ".gitignore": "node_modules/\ndist/\n.extension-data/\n",
    "api.ts":
      'import { os } from "@get-halo/extension-sdk/api";\nexport default { hello: os.handler(() => "Hello from your extension") };\n',
    "schema.ts":
      'import { defineSchema } from "@get-halo/extension-sdk/schema";\nexport default defineSchema({});\n',
    "view.tsx":
      'import { H1, MauiProvider, Padding } from "maui";\nexport default function View() { return <MauiProvider><Padding xy={8}><H1>Hello, extension</H1></Padding></MauiProvider>; }\n',
  };
  for (const [file, source] of Object.entries(files)) {
    const written = await writeFile(join(args.directory, file), source).catch(
      (cause) =>
        new ExtensionScaffoldError({ directory: args.directory, cause }),
    );
    if (written instanceof Error) return written;
  }
  return { directory: args.directory };
}
