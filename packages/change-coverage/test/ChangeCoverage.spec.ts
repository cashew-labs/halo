import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { resolve } from "node:path";
import * as errore from "errore";
import { execa } from "execa";
import { expect, test } from "vitest";
import { runChangeCoverage } from "@get-halo/change-coverage";

test("reports whether changed tests execute new source lines", async () => {
  const workspaceRoot = resolve(process.cwd(), "../..");
  const parent = resolve(workspaceRoot, "tmp/change-coverage-tests");
  await mkdir(parent, { recursive: true });
  const fixture = await mkdtemp(resolve(parent, "fixture-"));
  const packageDir = resolve(fixture, "packages/example");
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(
    async () => await rm(fixture, { recursive: true, force: true }),
  );

  await mkdir(resolve(packageDir, "src"), { recursive: true });
  await symlink(
    resolve(workspaceRoot, "node_modules"),
    resolve(fixture, "node_modules"),
    "dir",
  );
  await writeFile(
    resolve(fixture, "package.json"),
    '{"name":"coverage-fixture","private":true,"type":"module"}\n',
  );
  await writeFile(
    resolve(packageDir, "package.json"),
    '{"name":"example","private":true,"type":"module"}\n',
  );
  await execa("git", ["init", "-q"], { cwd: fixture });
  await execa("git", ["config", "user.email", "test@example.com"], {
    cwd: fixture,
  });
  await execa("git", ["config", "user.name", "Test"], { cwd: fixture });
  await execa("git", ["add", "package.json", "packages/example/package.json"], {
    cwd: fixture,
  });
  await execa("git", ["commit", "-qm", "baseline"], { cwd: fixture });

  await writeFile(
    resolve(packageDir, "src/calc.ts"),
    "export function double(value: number) {\n  return value * 2;\n}\n",
  );
  const testPath = resolve(packageDir, "src/calc.test.ts");
  await writeFile(
    testPath,
    'import { expect, test } from "vitest";\nimport { double } from "./calc.js";\ntest("doubles", () => expect(double(2)).toBe(4));\n',
  );

  const covered = await runChangeCoverage({
    packageDir,
    base: "HEAD",
    outputDir: resolve(fixture, "output"),
  });
  if (covered instanceof Error) throw covered;
  expect(covered.status).toBe("covered");
  expect(covered.testFiles).toEqual(["src/calc.test.ts"]);
  expect(covered.sourceFiles).toEqual(["src/calc.ts"]);
  expect(await readFile(covered.reportPath, "utf8")).toContain(
    "2/2 executable changed lines covered",
  );

  await writeFile(
    testPath,
    'import { expect, test } from "vitest";\ntest("unrelated", () => expect(1).toBe(1));\n',
  );
  const uncovered = await runChangeCoverage({
    packageDir,
    base: "HEAD",
    outputDir: resolve(fixture, "output"),
  });
  if (uncovered instanceof Error) throw uncovered;
  expect(uncovered.status).toBe("uncovered");
  expect(await readFile(uncovered.reportPath, "utf8")).toContain(
    "packages/example/src/calc.ts:1,2",
  );
}, 30_000);
