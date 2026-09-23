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
      ? { sdk: "0.3.0", tools: "0.3.0" }
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
          check: "npm run typecheck",
          start: "node dist/start.mjs",
          typecheck: "tsc --noEmit",
        },
        dependencies: {
          "@get-halo/extension-sdk": packages.sdk,
          react: "^19.2.8",
          "react-dom": "^19.2.8",
          maui: "npm:@tanishqkancharla/maui@0.0.30",
          errore: "^0.14.1",
          hono: "^4.13.8",
        },
        devDependencies: {
          "@get-halo/extension-tools": packages.tools,
          "@types/node": "^22.20.1",
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
          types: ["node"],
        },
        include: ["*.ts", "*.tsx"],
      },
      undefined,
      2,
    ),
    ".gitignore": "node_modules/\ndist/\n.extension-data/\n",
    "schema.ts":
      'import { defineRelations, defineSchema } from "@get-halo/extension-sdk/schema";\nexport const schema = defineSchema({});\nexport const relations = defineRelations(schema, () => ({}));\n',
    "extension.ts":
      'import { Hono } from "hono";\nimport { defineExtension, reactView, type ExtensionEnvironment } from "@get-halo/extension-sdk/server";\nimport { relations, schema } from "./schema.js";\nconst api = new Hono<{ Bindings: ExtensionEnvironment["Bindings"] }>().get("/hello", (context) => context.json({ message: "Hello from your extension" }));\nexport default defineExtension({ api, schema, relations, view: reactView("./view.tsx") });\n',
    "view.tsx":
      'import { Flex, H1, MauiProvider } from "maui";\nexport default function View() { return <MauiProvider><Flex column p={8}><H1>Hello, extension</H1></Flex></MauiProvider>; }\n',
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
