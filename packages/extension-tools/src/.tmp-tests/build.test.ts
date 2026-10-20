import * as fs from "node:fs/promises";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { buildExtension } from "../build.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});
const buildTest = test.extend<{ directory: string }>({
  // oxlint-disable-next-line no-empty-pattern -- Native fixture signature.
  directory: async ({}, use) => {
    const directory = await fs.mkdtemp(
      path.resolve(import.meta.dirname, "../../../../tmp/http-build-"),
    );
    await fs.mkdir(path.join(directory, "node_modules", "@get-halo"), {
      recursive: true,
    });
    await fs.symlink(
      path.resolve(import.meta.dirname, "../../../extension-sdk"),
      path.join(directory, "node_modules", "@get-halo", "extension-sdk"),
    );
    await Promise.all([
      fs.writeFile(
        path.join(directory, "view.tsx"),
        "export default () => null;",
      ),
      fs.writeFile(path.join(directory, "api.ts"), "export default {};"),
      fs.writeFile(
        path.join(directory, "schema.ts"),
        'import {defineSchema,defineRelations} from "@get-halo/extension-sdk/schema"; export const schema=defineSchema({}); export const relations=defineRelations(schema,()=>({}));',
      ),
    ]);
    try {
      await use(directory);
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
      vi.mocked(fs.stat).mockClear();
    }
  },
});
buildTest(
  "builds without an optional HTTP module and includes one when present",
  async ({ directory }) => {
    const without = await buildExtension(directory);
    if (without instanceof Error) throw without;
    await fs.writeFile(
      path.join(directory, "http.ts"),
      'export default () => Response.redirect("https://gethalo.dev/?utm_campaign=packed",302);',
    );
    const withHttp = await buildExtension(directory);
    if (withHttp instanceof Error) throw withHttp;
    expect(
      await fs.readFile(
        path.join(directory, "dist", withHttp.buildId, "server.mjs"),
        "utf8",
      ),
    ).toContain("utm_campaign=packed");
  },
);
buildTest(
  "reports a filesystem discovery error before publishing output",
  async ({ directory }) => {
    vi.mocked(fs.stat).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    expect(await buildExtension(directory)).toBeInstanceOf(Error);
  },
);
