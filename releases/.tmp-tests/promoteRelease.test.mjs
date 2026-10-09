import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const root = path.resolve(import.meta.dirname, "../..");
const temporary = path.join(root, "tmp", "promote-validation");

const staleConfig = [
  "config:",
  "  halo-control-plane:controlPlaneImage: example/control-plane:0.1.68",
  "  halo-control-plane:workspaceImage: example/workspace-server:0.1.68",
  "  halo-control-plane:exeTemplateVmName: halo-exe-0-1-68",
  "",
].join("\n");

async function promoteFixture(
  t,
  {
    stagingDraft = false,
    failPullRequest = false,
    production = { version: "0.1.68" },
  } = {},
) {
  await fs.mkdir(temporary, { recursive: true });
  const base = await fs.mkdtemp(path.join(temporary, "case-"));
  t.after(async () => await fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, "repo");
  const drivers = path.join(base, "drivers");
  await fs.mkdir(path.join(directory, "releases"), { recursive: true });
  await fs.mkdir(path.join(directory, "infra/control-plane"), {
    recursive: true,
  });
  await fs.mkdir(drivers);
  // promoteRelease.mjs runs from the real checkout and chdirs into the fixture
  // repository, which needs the validator it shells out to.
  for (const name of [
    "promotion.mjs",
    "validatePromotion.mjs",
    "releaseManifest.mjs",
  ])
    await fs.copyFile(
      path.join(root, "releases", name),
      path.join(directory, "releases", name),
    );
  await fs.writeFile(
    path.join(directory, "releases/0.1.70.json"),
    JSON.stringify({ version: "0.1.70", minimumFrontendVersion: "0.1.68" }),
  );
  await fs.writeFile(
    path.join(directory, "releases/0.1.66.json"),
    JSON.stringify({ version: "0.1.66", minimumFrontendVersion: "0.1.60" }),
  );
  if (production !== undefined)
    await fs.writeFile(
      path.join(directory, "releases/production.json"),
      JSON.stringify(production),
    );
  await fs.writeFile(
    path.join(directory, "infra/control-plane/Pulumi.prod.yaml"),
    staleConfig,
  );

  const requests = path.join(drivers, "gh.jsonl");
  // gh is the external boundary; git uses a real local bare remote.
  await fs.writeFile(
    path.join(drivers, "gh"),
    `#!${process.execPath}
const args = process.argv.slice(2);
require('node:fs').appendFileSync(${JSON.stringify(requests)}, JSON.stringify(args) + "\\n");
if (args[0] === "release" && args[1] === "view") console.log(JSON.stringify({ isDraft: ${stagingDraft} }));
if (args[0] === "pr" && ${failPullRequest}) process.exit(4);
`,
    { mode: 0o755 },
  );
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
      cwd: directory,
      env,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "user.name", "Promote test");
  git("config", "user.email", "promote-test@example.invalid");
  git("config", "commit.gpgsign", "false");
  git("config", "core.hooksPath", path.join(drivers, "no-hooks"));
  git("add", ".");
  git("commit", "-m", "Initial");
  const remote = path.join(base, "remote.git");
  git("init", "--bare", remote);
  git("remote", "add", "origin", remote);
  git("push", "--set-upstream", "origin", "main");

  const promote = (...args) =>
    spawnSync(
      process.execPath,
      [path.join(root, "releases/promoteRelease.mjs"), ...args],
      { cwd: directory, env, encoding: "utf8" },
    );
  const validate = (...args) =>
    spawnSync(
      process.execPath,
      [path.join(root, "releases/validatePromotion.mjs"), ...args],
      { cwd: directory, env, encoding: "utf8" },
    );
  const ghRequests = async () =>
    (await fs.readFile(requests, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  return { directory, git, promote, validate, ghRequests };
}

test("pnpm promote pins production, pushes a branch, and opens a PR", async (t) => {
  const setup = await promoteFixture(t);
  const result = setup.promote("0.1.70");
  assert.equal(result.status, 0, result.stderr);

  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(setup.directory, "releases/production.json"),
        "utf8",
      ),
    ),
    { version: "0.1.70" },
  );
  const config = await fs.readFile(
    path.join(setup.directory, "infra/control-plane/Pulumi.prod.yaml"),
    "utf8",
  );
  assert.match(config, /control-plane:0\.1\.70$/m);
  assert.match(config, /workspace-server:0\.1\.70$/m);
  assert.match(config, /exeTemplateVmName: halo-exe-0-1-70$/m);
  assert.equal(setup.git("status", "--porcelain"), "");
  assert.equal(
    setup.git("rev-parse", "HEAD"),
    setup.git("rev-parse", "origin/promote/0.1.70"),
  );

  const requests = await setup.ghRequests();
  assert.deepEqual(requests[0], [
    "release",
    "view",
    "0.1.70",
    "--repo",
    "cashew-labs/halo-staging",
    "--json",
    "isDraft",
  ]);
  assert.deepEqual(requests.at(-1).slice(0, 6), [
    "pr",
    "create",
    "--base",
    "main",
    "--head",
    "promote/0.1.70",
  ]);
});

test("pnpm promote refuses a staging release that is still a draft", async (t) => {
  const setup = await promoteFixture(t, { stagingDraft: true });
  const result = setup.promote("0.1.70");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /still a draft/);
  assert.equal(setup.git("branch", "--show-current"), "main");
});

test("pnpm promote refuses a version older than production", async (t) => {
  const setup = await promoteFixture(t);
  const result = setup.promote("0.1.66");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must be newer than production 0\.1\.68/);
});

test("pnpm promote refuses a version that was never released to staging", async (t) => {
  const setup = await promoteFixture(t);
  const result = setup.promote("0.1.71");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release 0\.1\.71 to staging first/);
});

test("pnpm promote requires a clean, current main", async (t) => {
  const setup = await promoteFixture(t);
  await fs.writeFile(path.join(setup.directory, "dirty.txt"), "x");
  const dirty = setup.promote("0.1.70");
  assert.equal(dirty.status, 1);
  assert.match(dirty.stderr, /Commit or stash local changes/);

  await fs.rm(path.join(setup.directory, "dirty.txt"));
  setup.git("switch", "-c", "feature");
  const branch = setup.promote("0.1.70");
  assert.equal(branch.status, 1);
  assert.match(branch.stderr, /from main/);
});

test("pnpm promote prints usage without exactly one version", async (t) => {
  const setup = await promoteFixture(t);
  for (const args of [[], ["0.1.70", "extra"]]) {
    const result = setup.promote(...args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: pnpm promote <version>/);
  }
});

test("pnpm promote creates production.json when none exists", async (t) => {
  const setup = await promoteFixture(t, { production: undefined });
  const result = setup.promote("0.1.70");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(
    JSON.parse(
      await fs.readFile(
        path.join(setup.directory, "releases/production.json"),
        "utf8",
      ),
    ),
    { version: "0.1.70" },
  );
});

test("pnpm promote requires local main to match origin", async (t) => {
  const setup = await promoteFixture(t);
  await fs.writeFile(path.join(setup.directory, "ahead.txt"), "x");
  setup.git("add", "ahead.txt");
  setup.git("commit", "-m", "Local only");
  const result = setup.promote("0.1.70");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /must match origin\/main/);
});

test("the promotion validator rejects malformed input", async (t) => {
  const setup = await promoteFixture(t);
  const usage = setup.validate();
  assert.equal(usage.status, 1);
  assert.match(usage.stderr, /Usage: node releases\/validatePromotion.mjs/);

  await fs.writeFile(
    path.join(setup.directory, "bad.json"),
    JSON.stringify({ version: "v0.1.70" }),
  );
  const malformed = setup.validate("bad.json");
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /must use major.minor.patch: v0.1.70/);

  await fs.writeFile(
    path.join(setup.directory, "missing.json"),
    JSON.stringify({ version: "0.1.99" }),
  );
  const missing = setup.validate("missing.json");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /releases\/0.1.99.json does not exist/);

  await fs.writeFile(
    path.join(setup.directory, "older.json"),
    JSON.stringify({ version: "0.1.66" }),
  );
  const older = setup.validate("older.json", "releases/production.json");
  assert.equal(older.status, 1);
  assert.match(older.stderr, /must be newer than production 0.1.68/);
});

test("pnpm promote reports a failed command", async (t) => {
  const setup = await promoteFixture(t, { failPullRequest: true });
  const result = setup.promote("0.1.70");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /gh exited with status 4/);
});
