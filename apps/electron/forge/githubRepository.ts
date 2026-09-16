import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

const rootPackageJsonPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
  "package.json",
);

const rootPackageJsonSchema = Type.Object({
  repository: Type.Object({
    type: Type.Literal("git"),
    url: Type.String(),
  }),
});

const packagedPackageJsonSchema = Type.Object(
  {},
  { additionalProperties: true },
);

class GithubRepositoryError extends errore.createTaggedError({
  name: "GithubRepositoryError",
  message: "GitHub repository is missing or invalid: $detail",
}) {}

export function readGithubRepository() {
  const raw = errore.try({
    try: () => readFileSync(rootPackageJsonPath, "utf8"),
    catch: (cause) =>
      new GithubRepositoryError({ detail: "read root package.json", cause }),
  });
  if (raw instanceof Error) return raw;

  const parsed = parseJson(raw, "parse root package.json");
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(rootPackageJsonSchema, parsed)) {
    return new GithubRepositoryError({
      detail: "root package.json repository must be { type: git, url }",
    });
  }

  return githubRepositoryFromUrl(parsed.repository.url);
}

/**
 * Copy the root repository URL into the packaged app package.json so
 * update-electron-app can guess the update.electronjs.org feed.
 */
export async function writeGithubRepositoryToPackagedApp(buildPath: string) {
  const repository = readGithubRepository();
  if (repository instanceof Error) return repository;

  const packageJsonPath = path.join(buildPath, "package.json");
  const raw = await readFile(packageJsonPath, "utf8").catch(
    (cause) =>
      new GithubRepositoryError({
        detail: "read packaged package.json",
        cause,
      }),
  );
  if (raw instanceof Error) return raw;

  const parsed = parseJson(raw, "parse packaged package.json");
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(packagedPackageJsonSchema, parsed)) {
    return new GithubRepositoryError({
      detail: "packaged package.json is not an object",
    });
  }

  const nextPackageJson = {
    ...parsed,
    repository: {
      type: "git",
      url: repository.url,
    },
  };
  const written = await writeFile(
    packageJsonPath,
    `${JSON.stringify(nextPackageJson, undefined, 2)}\n`,
  ).catch(
    (cause) =>
      new GithubRepositoryError({
        detail: "write packaged package.json",
        cause,
      }),
  );
  if (written instanceof Error) return written;
  return repository;
}

function parseJson(raw: string, detail: string) {
  return errore.try({
    try: () => {
      // SAFETY: JSON.parse is untyped; callers validate with TypeBox.
      return JSON.parse(raw) as unknown;
    },
    catch: (cause) => new GithubRepositoryError({ detail, cause }),
  });
}

function githubRepositoryFromUrl(url: string) {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/.exec(
    url,
  );
  if (match === null) {
    return new GithubRepositoryError({
      detail: `unsupported repository URL ${url}`,
    });
  }
  const owner = match[1];
  const name = match[2];
  if (owner === undefined || name === undefined) {
    return new GithubRepositoryError({
      detail: `unsupported repository URL ${url}`,
    });
  }
  return { owner, name, url };
}
