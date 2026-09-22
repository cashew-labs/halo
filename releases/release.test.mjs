import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createReleaseManifest } from "./releaseManifest.mjs";

const root = path.resolve(import.meta.dirname, "..");
const temporary = path.join(root, "tmp", "release-validation");

async function fixture(t) {
  await fs.mkdir(temporary, { recursive: true });
  const directory = await fs.mkdtemp(path.join(temporary, "case-"));
  t.after(async () => await fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function run(script, args, cwd, env = process.env) {
  return spawnSync(
    process.execPath,
    [path.join(root, "releases", script), ...args],
    { cwd, env, encoding: "utf8" },
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

function frontend(version, workspace, controlPlane = 3) {
  return {
    version,
    minimumFrontendVersion: version,
    protocols: {
      workspace: { client: workspace, supported: [workspace] },
      controlPlane: { client: controlPlane, supported: [controlPlane] },
    },
  };
}

async function releaseFixture(t, previous, next) {
  const directory = await fixture(t);
  for (const folder of ["releases", "apps/electron", "infra/control-plane"])
    await fs.mkdir(path.join(directory, folder), { recursive: true });
  await fs.writeFile(
    path.join(directory, "apps/electron/package.json"),
    JSON.stringify({ version: next.version }),
  );
  await fs.writeFile(
    path.join(directory, "infra/control-plane/Pulumi.west.yaml"),
    ["control-plane", "workspace-server"]
      .map(
        (image) =>
          `  halo-control-plane:${image === "control-plane" ? "controlPlaneImage" : "workspaceImage"}: us-west2-docker.pkg.dev/halo-relay/halo-west-workspaces/${image}:${next.version}`,
      )
      .join("\n"),
  );
  const write = async (release) =>
    await fs.writeFile(
      path.join(directory, "releases", `${release.version}.json`),
      JSON.stringify(release),
    );
  for (const release of previous) await write(release);
  return {
    directory,
    async validate(release = next) {
      await write(release);
      return run(
        "validateRelease.mjs",
        [`releases/${release.version}.json`],
        directory,
      );
    },
    write,
  };
}

test("first release retires 0.1.52 and subsequent releases inherit the minimum", async (t) => {
  const legacy = JSON.parse(
    await fs.readFile(path.join(root, "releases/0.1.52.json"), "utf8"),
  );
  const release = createReleaseManifest({
    version: "0.1.53",
    previous: legacy,
    protocols: frontend("0.1.53", 18).protocols,
  });
  assert(!(release instanceof Error));
  assert.equal(release.minimumFrontendVersion, "0.1.53");
  const setup = await releaseFixture(t, [legacy], release);
  const validated = await setup.validate();
  assert.equal(validated.status, 0, validated.stderr);

  const next = createReleaseManifest({
    version: "0.1.54",
    previous: release,
    protocols: release.protocols,
  });
  assert(!(next instanceof Error));
  assert.equal(next.minimumFrontendVersion, "0.1.53");
  const later = createReleaseManifest({
    version: "0.1.55",
    previous: next,
    protocols: next.protocols,
  });
  assert(!(later instanceof Error));
  assert.equal(later.minimumFrontendVersion, "0.1.53");
  const nextSetup = await releaseFixture(t, [release], next);
  assert.equal((await nextSetup.validate()).status, 0);
});

test("prerelease CLI records the initial, inherited and explicitly raised minimum", async (t) => {
  const setup = await releaseFixture(t, [{ version: "0.1.52" }], {
    version: "0.1.52",
  });
  const drivers = await fixture(t);
  const remote = path.join(drivers, "remote.git");
  const prRequest = path.join(drivers, "pr.json");
  const env = {
    ...process.env,
    PATH: [drivers, path.dirname(process.execPath), process.env.PATH].join(
      path.delimiter,
    ),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(drivers, "gitconfig"),
  };
  await fs.writeFile(env.GIT_CONFIG_GLOBAL, "");
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: setup.directory,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  // External CLI boundaries are local drivers; Git uses a real local bare remote.
  await fs.writeFile(
    path.join(drivers, "pnpm"),
    `#!${process.execPath}
require('node:assert/strict').deepEqual(process.argv.slice(2), ['--silent', '--filter', '@get-halo/control-plane', 'exec', 'tsx', '../../releases/protocols.mjs']);
console.log(${JSON.stringify(JSON.stringify(frontend("0.1.53", 18).protocols))});
`,
    { mode: 0o755 },
  );
  await fs.writeFile(
    path.join(drivers, "gh"),
    `#!${process.execPath}
require('node:fs').writeFileSync(${JSON.stringify(prRequest)}, JSON.stringify(process.argv.slice(2)));
`,
    { mode: 0o755 },
  );
  for (const name of ["validateRelease.mjs", "releaseManifest.mjs"])
    await fs.copyFile(
      path.join(root, "releases", name),
      path.join(setup.directory, "releases", name),
    );
  git("init", "--initial-branch=main");
  git("config", "user.name", "Release test");
  git("config", "user.email", "release-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(drivers, "no-hooks"));
  git("add", ".");
  git("commit", "-m", "Initial local release");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("push", "--set-upstream", "origin", "main");

  for (const [version, minimum, extra] of [
    ["0.1.53", "0.1.53", []],
    ["0.1.54", "0.1.53", []],
    ["0.1.55", "0.1.55", ["--minimum-frontend", "0.1.55"]],
    ["0.1.56", "0.1.55", []],
  ]) {
    const result = run(
      "createRelease.mjs",
      [version, ...extra],
      setup.directory,
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(setup.directory, "releases", `${version}.json`),
        "utf8",
      ),
    );
    assert.equal(manifest.minimumFrontendVersion, minimum);
    assert.equal(git("status", "--porcelain"), "");
    assert.equal(
      git("rev-parse", "HEAD"),
      git("rev-parse", `origin/release/${version}`),
    );
    const request = JSON.parse(await fs.readFile(prRequest, "utf8"));
    assert.deepEqual(request.slice(0, 6), [
      "pr",
      "create",
      "--base",
      "main",
      "--head",
      `release/${version}`,
    ]);
    git("switch", "main");
    git("merge", "--ff-only", `release/${version}`);
    git("push", "origin", "main");
  }
});

test("generation refuses to reset a missing minimum after the migration", () => {
  const previous = frontend("0.1.53", 18);
  delete previous.minimumFrontendVersion;
  const result = createReleaseManifest({
    version: "0.1.54",
    previous,
    protocols: previous.protocols,
  });
  assert(result instanceof Error);
  assert.match(result.message, /no minimum supported frontend/);
});

test("an explicitly advanced minimum is inherited by the following release", () => {
  const previous = frontend("0.1.53", 18);
  const release = createReleaseManifest({
    version: "0.1.54",
    previous,
    protocols: frontend("0.1.54", 19).protocols,
    minimumFrontendVersion: "0.1.54",
  });
  assert(!(release instanceof Error));
  assert.equal(release.minimumFrontendVersion, "0.1.54");
  const next = createReleaseManifest({
    version: "0.1.55",
    previous: release,
    protocols: release.protocols,
  });
  assert(!(next instanceof Error));
  assert.equal(next.minimumFrontendVersion, "0.1.54");
});

test("both APIs must retain every frontend protocol inside the supported range", async (t) => {
  const first = frontend("0.1.53", 18, 3);
  const previous = frontend("0.1.54", 19, 4);
  const release = {
    ...frontend("0.1.55", 20, 5),
    previousVersion: previous.version,
    minimumFrontendVersion: first.version,
  };
  release.protocols.workspace.supported = [18, 19, 20];
  release.protocols.controlPlane.supported = [3, 4, 5];
  const setup = await releaseFixture(t, [first, previous], release);
  const validated = await setup.validate();
  assert.equal(validated.status, 0, validated.stderr);
  for (const [service, protocols] of [
    ["workspace", [18, 19, 20]],
    ["controlPlane", [3, 4, 5]],
  ]) {
    for (const protocol of protocols) {
      const changed = structuredClone(release);
      changed.protocols[service].supported = protocols.filter(
        (value) => value !== protocol,
      );
      const rejected = await setup.validate(changed);
      assert.notEqual(rejected.status, 0);
      assert.match(
        rejected.stderr,
        new RegExp(`${service} must support protocol ${protocol}`),
      );
    }
  }
});

test("raising the minimum retires only protocols unused by the remaining frontends", async (t) => {
  const first = frontend("0.1.53", 18, 3);
  const previous = frontend("0.1.54", 19, 4);
  previous.protocols.workspace.supported = [18, 19, 99];
  previous.protocols.controlPlane.supported = [3, 4];
  const release = {
    ...frontend("0.1.55", 20, 5),
    previousVersion: previous.version,
    minimumFrontendVersion: previous.version,
  };
  release.protocols.workspace.supported = [19, 20];
  release.protocols.controlPlane.supported = [4, 5];
  const setup = await releaseFixture(t, [first, previous], release);
  const validated = await setup.validate();
  assert.equal(validated.status, 0, validated.stderr);

  previous.protocols.workspace.client = 18;
  await setup.write(previous);
  assert.match(
    (await setup.validate()).stderr,
    /workspace must support protocol 18 for frontend 0.1.54/,
  );
  release.minimumFrontendVersion = release.version;
  release.protocols.workspace.supported = [20];
  release.protocols.controlPlane.supported = [5];
  assert.equal((await setup.validate()).status, 0);
});

test("legacy metadata requires protocol 17 if 0.1.52 remains inside the range", async (t) => {
  const release = {
    ...frontend("0.1.53", 18),
    previousVersion: "0.1.52",
    minimumFrontendVersion: "0.1.52",
  };
  const setup = await releaseFixture(t, [{ version: "0.1.52" }], release);
  assert.match(
    (await setup.validate()).stderr,
    /workspace must support protocol 17 for frontend 0.1.52/,
  );
  release.protocols.workspace.supported = [17, 18];
  assert.equal((await setup.validate()).status, 0);
});

test("minimum must be present, valid and identify an existing release no newer than the candidate", async (t) => {
  const previous = frontend("0.1.53", 18);
  const release = {
    ...frontend("0.1.54", 18),
    previousVersion: previous.version,
  };
  const setup = await releaseFixture(t, [previous], release);
  for (const minimum of [undefined, "invalid", "0.1.55", "0.1.52"]) {
    const rejected = await setup.validate({
      ...release,
      minimumFrontendVersion: minimum,
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /minimum supported frontend/i);
  }
});

test("version comparisons are numeric across minor and major releases", async (t) => {
  const first = frontend("0.9.9", 18);
  const previous = frontend("0.10.0", 19);
  const release = {
    ...frontend("1.0.0", 20),
    previousVersion: previous.version,
    minimumFrontendVersion: previous.version,
  };
  release.protocols.workspace.supported = [19, 20];
  const setup = await releaseFixture(t, [first, previous], release);
  assert.equal((await setup.validate()).status, 0);
  release.minimumFrontendVersion = first.version;
  assert.match(
    (await setup.validate()).stderr,
    /workspace must support protocol 18/,
  );
});

test("missing or invalid protocol metadata inside the range cannot bypass validation", async (t) => {
  const first = frontend("0.1.53", 18);
  const previous = frontend("0.1.54", 18);
  const release = {
    ...frontend("0.1.55", 18),
    previousVersion: previous.version,
    minimumFrontendVersion: first.version,
  };
  const setup = await releaseFixture(t, [first, previous], release);
  for (const metadata of [
    undefined,
    { workspace: { client: 18 } },
    { workspace: { client: "18" }, controlPlane: { client: 3 } },
  ]) {
    await setup.write({ ...previous, protocols: metadata });
    assert.match(
      (await setup.validate()).stderr,
      /Release 0.1.54 has no valid .* client protocol/,
    );
  }
  await setup.write(previous);
  for (const supported of [[], [0], [18.5], ["18"]]) {
    const changed = structuredClone(release);
    changed.protocols.workspace.supported = supported;
    assert.match(
      (await setup.validate(changed)).stderr,
      /Invalid workspace protocols/,
    );
  }
});
