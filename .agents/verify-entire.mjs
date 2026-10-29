import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Exercise real Entire/Git hooks offline. Only Amp's thread export is a fixture.
const root = fileURLToPath(new URL("..", import.meta.url));
fs.mkdirSync(path.join(root, "tmp"), { recursive: true });
const scratch = fs.mkdtempSync(path.join(root, "tmp/entire-check-"));
const cwd = path.join(scratch, "repo");
const thread = `T-${randomUUID()}`;
const entire = execFileSync(
  "sh",
  ["-c", 'command -v "$1"', "sh", process.argv[2] ?? "entire"],
  {
    encoding: "utf8",
  },
).trim();
const env = {
  PATH: `${scratch}/bin:${process.env.PATH}`,
  HOME: `${scratch}/home`,
  XDG_CONFIG_HOME: `${scratch}/home/.config`,
  XDG_CACHE_HOME: `${scratch}/home/.cache`,
  ENTIRE_CONFIG_DIR: `${scratch}/home/.config/entire`,
  ENTIRE_TOKEN_STORE: "file",
  ENTIRE_TOKEN_STORE_PATH: `${scratch}/home/token.json`,
  ENTIRE_TEST_AUTH_STORE_FILE: `${scratch}/home/auth.json`,
  ENTIRE_TELEMETRY_OPTOUT: "1",
  ENTIRE_REPO_ROOT: cwd,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_ALLOW_PROTOCOL: "file",
  GIT_TERMINAL_PROMPT: "0",
};
const run = (command, args, input) =>
  execFileSync(command, args, {
    cwd,
    env,
    input,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 10_000,
  });
const write = (file, value) => {
  const destination = path.join(cwd, file);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, value);
};
const hook = (event) =>
  run(
    "entire",
    ["hooks", "amp", event],
    JSON.stringify({
      type: event,
      cwd,
      thread_id: thread,
      message: "Update workspace instructions",
      status: "done",
    }),
  );

try {
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(`${scratch}/home`, { recursive: true });
  fs.mkdirSync(`${scratch}/bin`, { recursive: true });
  fs.symlinkSync(entire, `${scratch}/bin/entire`);
  fs.writeFileSync(
    `${scratch}/bin/amp`,
    `#!/bin/sh\ncat '${scratch}/export.json'\n`,
    { mode: 0o755 },
  );
  run("git", ["init", "-q", "-b", "main"]);
  run("git", ["config", "user.name", "Entire setup check"]);
  run("git", ["config", "user.email", "entire-check@example.invalid"]);
  run("git", ["config", "core.hooksPath", ".git/hooks"]);
  run("git", ["config", "commit.gpgsign", "false"]);
  write(".gitignore", ".entire/\n.amp/\n");
  for (const file of [
    ".agents/setup",
    ".agents/old",
    "src/value.ts",
    "untouched.txt",
  ]) {
    write(file, "before\n");
  }
  write(".agents/hooks.json", "{}\n");
  run("git", ["add", "."]);
  run("git", ["commit", "-qm", "Baseline"]);
  for (const remote of ["origin", "checkpoints"]) {
    const store = `${scratch}/${remote}.git`;
    run("git", ["init", "--bare", "-q", store]);
    run("git", ["remote", "add", remote, store]);
  }
  write(
    ".entire/settings.json",
    JSON.stringify({
      enabled: true,
      telemetry: false,
      checkpoints: { primary: { type: "git-refs" } },
    }),
  );
  write(
    ".entire/settings.local.json",
    JSON.stringify({
      strategy_options: {
        push_sessions: true,
        checkpoint_push_remote: "checkpoints",
      },
    }),
  );
  const projectSettings = fs.readFileSync(
    `${cwd}/.entire/settings.json`,
    "utf8",
  );
  run("entire", ["agent", "add", "amp", "--local"]);
  assert.equal(
    fs.readFileSync(`${cwd}/.entire/settings.json`, "utf8"),
    projectSettings,
    "Hook repair changed project settings",
  );
  const messages = [
    {
      role: "user",
      messageId: "u1",
      content: [{ type: "text", text: "Update workspace instructions" }],
    },
  ];
  const exportThread = () =>
    fs.writeFileSync(
      `${scratch}/export.json`,
      JSON.stringify({ id: thread, messages }),
    );
  exportThread();
  hook("session.start");
  hook("agent.start");
  write(".agents/setup", "after\n");
  write(".agents/skills/check/SKILL.md", "Workspace instructions\n");
  fs.renameSync(`${cwd}/.agents/old`, `${cwd}/.agents/new`);
  write("src/value.ts", "after\n");
  write(".agents/hooks.json", '{"verification":true}\n');
  messages.push({
    role: "assistant",
    messageId: "a1",
    content: [
      {
        type: "tool_use",
        id: "edit1",
        name: "apply_patch",
        input: {
          patchText: [
            "*** Begin Patch",
            `*** Update File: ${cwd}/.agents/setup`,
            "@@",
            "-before",
            "+after",
            `*** Add File: ${cwd}/.agents/skills/check/SKILL.md`,
            "+Workspace instructions",
            `*** Update File: ${cwd}/.agents/old`,
            `*** Move to: ${cwd}/.agents/new`,
            "@@",
            "-before",
            "+before",
            `*** Update File: ${cwd}/src/value.ts`,
            "@@",
            "-before",
            "+after",
            `*** Update File: ${cwd}/.agents/hooks.json`,
            "@@",
            "-{}",
            '+{"verification":true}',
            "*** End Patch",
          ].join("\n"),
        },
      },
    ],
  });
  messages.push({
    role: "user",
    messageId: "u2",
    content: [
      {
        type: "tool_result",
        toolUseID: "edit1",
        run: { status: "done", result: { files: [] } },
      },
    ],
  });
  exportThread();
  hook("agent.end");
  run("git", ["add", "."]);
  run("git", ["commit", "-qm", "Update workspace instructions"]);
  const checkpoint = /^Entire-Checkpoint: (\S+)/m.exec(
    run("git", ["log", "-1", "--format=%B"]),
  )?.[1];
  assert.ok(
    checkpoint,
    "Entire did not attach a checkpoint to the smoke-test commit",
  );
  const ref = `refs/entire/checkpoints/${checkpoint.slice(-2)}/${checkpoint}`;
  const metadata = JSON.parse(run("git", ["show", `${ref}:0/metadata.json`]));
  assert.deepEqual(
    metadata.files_touched.toSorted(),
    [
      ".agents/new",
      ".agents/old",
      ".agents/setup",
      ".agents/skills/check/SKILL.md",
      "src/value.ts",
    ],
    "Entire lost user edits or captured its own hooks",
  );
  const transcript = run("entire", [
    "checkpoint",
    "explain",
    checkpoint,
    "--transcript",
  ]);
  assert.ok(
    transcript.includes("apply_patch"),
    "Stored checkpoint has no edit transcript",
  );
  run("git", ["push", "-q", "origin", "main"]);
  // checkpoint_push_remote gates sync; it does not redirect the user's push.
  run("git", ["push", "-q", "checkpoints", "main"]);
  assert.ok(
    run("git", ["ls-remote", "checkpoints", ref]).includes(ref),
    "Checkpoint did not reach its separate remote",
  );
  assert.equal(
    run("git", [
      "ls-remote",
      "origin",
      "refs/entire/*",
      "refs/heads/entire/*",
    ]).trim(),
    "",
    "Checkpoint leaked into the code remote",
  );
  console.log(
    "Entire capture check passed: .agents edits, stored transcript, separate checkpoint sync",
  );
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
