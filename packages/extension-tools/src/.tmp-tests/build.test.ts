import { expect, test as base } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { buildExtension } from "../build.js";

const repository = path.resolve(import.meta.dirname, "../../../..");
const test = base.extend<{ directory: string }>({
  // oxlint-disable-next-line eslint/no-empty-pattern -- Vitest fixtures require object destructuring.
  directory: async ({}, use) => {
    const parent = path.join(repository, "tmp", "loading-speed");
    await fs.mkdir(parent, { recursive: true });
    const directory = await fs.mkdtemp(path.join(parent, "extension-"));
    await fs.mkdir(path.join(directory, "node_modules", "@get-halo"), {
      recursive: true,
    });
    for (const name of ["react", "react-dom", "maui"])
      await fs.symlink(
        path.join(repository, "node_modules", name),
        path.join(directory, "node_modules", name),
      );
    await fs.symlink(
      path.join(repository, "packages", "extension-sdk"),
      path.join(directory, "node_modules", "@get-halo", "extension-sdk"),
    );
    await fs.writeFile(
      path.join(directory, "api.ts"),
      'import { os } from "@get-halo/extension-sdk/api"; export default { hello: os.handler(() => "hello") };',
    );
    await fs.writeFile(
      path.join(directory, "schema.ts"),
      'import { defineRelations, defineSchema } from "@get-halo/extension-sdk/schema"; export const schema = defineSchema({}); export const relations = defineRelations(schema, () => ({}));',
    );
    await fs.copyFile(
      path.join(repository, "apps/electron/e2e/fixtures/greeting/view.tsx"),
      path.join(directory, "view.tsx"),
    );
    await use(directory);
    await fs.rm(directory, { recursive: true, force: true });
  },
});

test("builds a production extension view within its JavaScript budget", async ({
  directory,
}) => {
  const built = await buildExtension(directory);
  expect(built).not.toBeInstanceOf(Error);
  if (built instanceof Error) throw built;
  const output = path.join(directory, "dist", built.buildId, "public");
  const view = await fs.readFile(path.join(output, "view.js"));
  expect(view.byteLength).toBeLessThan(1_000_000);
  expect(view.toString()).not.toContain("function Greeting(");
  expect(await fs.readFile(path.join(output, "index.html"), "utf8")).toContain(
    "./assets/view.js",
  );
});
