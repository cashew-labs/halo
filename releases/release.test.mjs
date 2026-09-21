import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const temporary = path.join(root, "tmp", "release-validation");

async function fixture(t) {
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, "case-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(script, args, cwd) {
  return spawnSync(
    process.execPath,
    [path.join(root, "releases", script), ...args],
    { cwd, encoding: "utf8" },
  );
}

test("publication rejects a different source or modified prepared archive", async (t) => {
  const directory = await fixture(t);
  const revision = "a".repeat(40);
  await fs.writeFile(
    path.join(directory, "desktop.tgz"),
    "verified signed artifact",
  );
  const args = [directory, "0.1.53", revision];
  assert.equal(
    run("preparedArtifact.mjs", ["record", ...args], directory).status,
    0,
  );
  assert.equal(
    run("preparedArtifact.mjs", ["verify", ...args], directory).status,
    0,
  );
  assert.notEqual(
    run(
      "preparedArtifact.mjs",
      ["verify", directory, "0.1.53", "b".repeat(40)],
      directory,
    ).status,
    0,
  );
  await fs.appendFile(path.join(directory, "desktop.tgz"), "changed");
  assert.notEqual(
    run("preparedArtifact.mjs", ["verify", ...args], directory).status,
    0,
  );
});

test("release validation blocks removing any previously supported protocol", async (t) => {
  const directory = await fixture(t);
  for (const folder of ["releases", "apps/electron", "infra/control-plane"])
    await fs.mkdir(path.join(directory, folder), { recursive: true });
  await fs.writeFile(
    path.join(directory, "apps/electron/package.json"),
    JSON.stringify({ version: "0.1.54" }),
  );
  await fs.writeFile(
    path.join(directory, "infra/control-plane/Pulumi.west.yaml"),
    ["control-plane", "workspace-server"]
      .map(
        (image) =>
          `us-west2-docker.pkg.dev/halo-relay/halo-west-workspaces/${image}:0.1.54`,
      )
      .join("\n"),
  );
  const previous = {
    version: "0.1.53",
    protocols: {
      workspace: { client: 19, supported: [18, 19] },
      controlPlane: { client: 3, supported: [3] },
    },
  };
  await fs.writeFile(
    path.join(directory, "releases/0.1.53.json"),
    JSON.stringify(previous),
  );
  const release = {
    version: "0.1.54",
    previousVersion: "0.1.53",
    protocols: structuredClone(previous.protocols),
  };
  const file = path.join(directory, "releases/0.1.54.json");
  const validate = () => run("validateRelease.mjs", [file], directory);
  await fs.writeFile(file, JSON.stringify(release));
  assert.equal(validate().status, 0);
  release.protocols.workspace.supported = [19];
  await fs.writeFile(file, JSON.stringify(release));
  assert.match(validate().stderr, /must retain protocol 18/);
  release.protocols.workspace.supported = [];
  await fs.writeFile(file, JSON.stringify(release));
  assert.match(validate().stderr, /Invalid workspace protocols/);
});
