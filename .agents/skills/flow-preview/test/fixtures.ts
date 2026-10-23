import childProcess from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import url from "node:url";
import { test as base } from "@playwright/test";
import * as errore from "errore";
import { createServer } from "vite";

const skill = url.fileURLToPath(new URL("../", import.meta.url));

export const test = base.extend<
  {},
  { preview: { origin: string; name: string; project: string } }
>({
  preview: [
    // oxlint-disable-next-line eslint/no-empty-pattern -- Playwright fixture callbacks require destructured parameters.
    async ({}, use) => {
      const name = `flow-preview-test-${crypto.randomUUID()}`;
      const project = path.join(skill, "tmp", name);
      await using cleanup = new errore.AsyncDisposableStack();
      await fs.mkdir(project, { recursive: true });
      cleanup.defer(async () => {
        await fs.rm(project, { recursive: true });
      });
      // The skill can move independently; generated previews outlive that copy.
      const portableSkill = path.join(project, "portable-skill");
      await fs.mkdir(portableSkill);
      for (const resource of ["scripts", "assets", "package.json"]) {
        await fs.cp(
          path.join(skill, resource),
          path.join(portableSkill, resource),
          { recursive: true },
        );
      }
      const directory = path.join(project, "tmp", name);
      const generated = childProcess.spawnSync(
        process.execPath,
        [path.join(portableSkill, "scripts/generate.mjs"), name],
        { cwd: project, encoding: "utf8" },
      );
      if (generated.status !== 0)
        throw new Error(generated.stderr, { cause: generated.error });
      await fs.rm(portableSkill, { recursive: true });
      await fs.mkdir(path.join(project, "src"));
      await fs.writeFile(
        path.join(project, "src", "settings.ts"),
        'export const digestName = "Morning digest";',
      );
      const entry = path.join(directory, "scenario.tsx");
      await fs.writeFile(
        entry,
        'import { digestName } from "../../src/settings.js";\n' +
          (await fs.readFile(entry, "utf8")).replace(
            'useState("Morning digest")',
            "useState(digestName)",
          ),
      );
      const config = path.join(directory, "vite.config.mjs");
      await fs.writeFile(
        config,
        (await fs.readFile(config, "utf8")).replace(
          "port: 4180",
          'port: 4180, sourceRoots: ["../../src"]',
        ),
      );
      const server = await createServer({
        configFile: path.join(directory, "vite.config.mjs"),
        server: { port: 0 },
      });
      cleanup.defer(async () => {
        await server.close();
      });
      await server.listen();
      await use({
        origin: new URL(server.resolvedUrls!.local[0]!).origin,
        name,
        project,
      });
    },
    { scope: "worker" },
  ],
});
