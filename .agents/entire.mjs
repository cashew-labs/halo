import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";

// No transcript, query result, credential or child stderr goes into health logs.
const root = fileURLToPath(new URL("..", import.meta.url));
const checkpointRepo = "cashew-labs/halo-checkpoints";
const checkpointURL = `https://github.com/${checkpointRepo}`;
const receipt = path.join(root, ".entire/tmp/memory-health.json");
const localOnly = { ENTIRE_BRAIN_NO_EGRESS: "1" };
let results = {};
const run = (command, args, env = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      ...(command === "entire" && args[0] === "brain" ? localOnly : {}),
      ...env,
    },
  }).trim();
const json = (command, args, env) => JSON.parse(run(command, args, env));
function check(name, action) {
  try {
    const detail = action();
    results[name] =
      typeof detail === "string" ? { state: "verified", detail } : detail;
  } catch {
    results[name] = {
      state: "unavailable",
      detail: "See recovery commands in AGENTS.md",
    };
  }
  console.log(`${name}: ${results[name].state} — ${results[name].detail}`);
  return results[name].state === "verified";
}
function skip(name, detail) {
  results[name] = { state: "not verified", detail };
  console.log(`${name}: not verified — ${detail}`);
}
function privateRepository() {
  const repo = json("gh", ["api", `repos/${checkpointRepo}`]);
  assert.equal(repo.private, true, "Checkpoint repository must remain private");
}
function safeOrigin() {
  const origin = run("git", ["remote", "get-url", "origin"]);
  assert.match(
    origin,
    /^(?:https:\/\/github\.com\/|git@github\.com:)cashew-labs\/halo(?:\.git)?$/,
  );
  const settings = JSON.parse(
    fs.readFileSync(path.join(root, ".entire/settings.json")),
  );
  assert.deepEqual(settings.strategy_options.checkpoint_remote, {
    provider: "github",
    repo: checkpointRepo,
  });
  assert.ok(
    run("entire", ["status"]).includes(
      `Checkpoints sync to: dedicated checkpoint remote (${checkpointRepo})`,
    ),
  );
  return "upstream clone; private checkpoint destination preserved";
}
function refresh() {
  results = {};
  try {
    if (!check("Privacy boundary", safeOrigin)) return;
    if (
      !check("Private checkpoint fetch", () => {
        privateRepository();
        run("git", [
          "fetch",
          "--no-write-fetch-head",
          "--no-prune",
          "--no-tags",
          checkpointURL,
          "refs/entire/checkpoints/*:refs/entire/checkpoints/*",
        ]);
        return "private git-refs fetched; public origin unchanged";
      })
    )
      return;
    if (
      !check("Brain refresh", () => {
        const brainPath = run("entire", ["brain", "path"]);
        run("entire", [
          "brain",
          "memory",
          "configure",
          "abstracts",
          "--disable",
          "--json",
        ]);
        // Compact checkpoints currently index to empty conversation records.
        // The patched flag preserves legacy caches on this unattended raw refresh.
        run("entire", [
          "brain",
          "refresh",
          "--raw",
          "--no-transcript-sweep",
          "--agent",
          "none",
        ]);
        const manifest = JSON.parse(
          fs.readFileSync(path.join(brainPath, "manifest.json")),
        );
        return `${manifest.checkpoints_scanned} checkpoints; ${manifest.sessions.length} sessions; no model calls`;
      })
    )
      return;
    check("Hosted memory sync", () => {
      privateRepository();
      if (!json("entire", ["auth", "status", "--json"]).logged_in) {
        return {
          state: "not verified",
          detail:
            "No Entire login; run ENTIRE_TOKEN_STORE=file entire login --device",
        };
      }
      const brainPath = run("entire", ["brain", "path"]);
      const target = json("entire", [
        "repo",
        "view",
        `/gh/${checkpointRepo}`,
        "--json",
      ]);
      assert.equal(target.repo, `/gh/${checkpointRepo}`);
      assert.equal(target.private, true);
      assert.match(target.repoId, /^[0-9A-HJKMNP-TV-Z]{26}$/);
      assert.match(target.apiUrl, /^https:\/\/[a-z0-9-]+\.api\.entire\.io\/?$/);
      // Explicit manual sync never rebinds to public origin on a 403 (Brain 0.4).
      // Mint into child environment only: never persist or put a token in argv.
      const token = run("entire", ["auth", "token"]);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(brainPath, "manifest.json")),
      );
      const currentBranch = run("git", ["branch", "--show-current"]);
      const branches = new Set(
        [
          manifest.default_branch,
          currentBranch,
          ...(manifest.sources?.facts?.branches ?? []),
        ].filter(Boolean),
      );
      let completed = 0;
      for (const branch of branches) {
        if (
          check(`Memory branch ${branch}`, () => {
            // Recheck after slow placement/auth work, immediately before each upload.
            // Disconnect does not cancel a request already in flight.
            const bindingPath = path.join(brainPath, "hosted.json");
            if (fs.existsSync(bindingPath)) {
              assert.notEqual(
                JSON.parse(fs.readFileSync(bindingPath)).opted_out,
                true,
              );
            }
            const synced = json(
              "entire",
              [
                "brain",
                "memories",
                "sync",
                "--memories-backend",
                "http",
                "--repo-id",
                target.repoId,
                "--api-url",
                target.apiUrl,
                "--branch",
                branch,
                // The patched pull snapshots this branch before network calls.
                // Other stores only upload; leave their local contents unchanged.
                ...(branch === currentBranch ? [] : ["--push-only"]),
                "--json",
              ],
              {
                ENTIRE_BRAIN_NO_EGRESS: "",
                ENTIRE_BRAIN_LOCAL_ONLY: "",
                ENTIRE_API_TOKEN: token,
              },
            );
            assert.notEqual(synced.skipped, true);
            assert.equal(typeof synced.skipped_unpublishable, "number");
            const detail = `private target; pushed ${synced.pushed_added + synced.pushed_changed} memories; ${synced.push_only ? "upload only; local store unchanged" : `pulled ${synced.feed_facts}`}; skipped ${synced.skipped_unpublishable} unpublishable`;
            return {
              state:
                synced.skipped_unpublishable === 0 ? "verified" : "degraded",
              detail,
            };
          })
        )
          completed++;
      }
      return {
        state: completed === branches.size ? "verified" : "degraded",
        detail: `${completed}/${branches.size} branches uploaded to private target; only current checkout pulls`,
      };
    });
  } finally {
    fs.mkdirSync(path.dirname(receipt), { recursive: true });
    const pendingReceipt = `${receipt}.${process.pid}.tmp`;
    fs.writeFileSync(
      pendingReceipt,
      JSON.stringify({ at: new Date().toISOString(), results }),
      { mode: 0o600 },
    );
    fs.renameSync(pendingReceipt, receipt);
  }
}
function health(remote) {
  check("Privacy boundary", safeOrigin);
  check("Local capture (offline fixture)", () =>
    run("node", [".agents/verify-entire.mjs"]),
  );
  check("Graph binary", () => {
    const version = json("entire", ["graph", "version", "--json"]);
    assert.equal(version.provider, "entire-graph");
    assert.equal(version.version, "v0.6.0");
    return version.version;
  });
  check("Brain binary", () => {
    assert.equal(run("entire", ["brain", "version"]), "0.4.0+halo.raw");
    assert.ok(
      json("entire", ["brain", "capabilities", "--json"]).features.includes(
        "task_briefs",
      ),
    );
    return "0.4.0+halo.raw; task briefs available";
  });
  check("Brain local index", () => {
    const status = json("entire", ["brain", "status", "--json"]);
    assert.equal(status.brain.manifest_state, "current");
    const graph = status.semantic?.freshness?.severity;
    const retrieval = status.retrieval?.freshness?.severity;
    return {
      state: graph === "ok" && retrieval === "ok" ? "verified" : "degraded",
      detail: `manifest current; Graph ${graph}; retrieval ${retrieval} (committed HEAD, not uncommitted edits)`,
    };
  });
  check("Memory worker receipt", () => {
    if (fs.existsSync(receipt)) {
      const last = JSON.parse(fs.readFileSync(receipt));
      console.log(
        `Last memory worker pass: ${last.at} (historical, not a live check)`,
      );
      for (const [name, result] of Object.entries(last.results)) {
        console.log(`  ${name}: ${result.state} — ${result.detail}`);
      }
      return {
        state: "not verified",
        detail: "historical results only; not live worker verification",
      };
    } else {
      return {
        state: "not verified",
        detail: "initializing; inspect amp orb service logs entire-memory",
      };
    }
  });
  if (!remote) {
    skip(
      "Checkpoint upload",
      "run node .agents/entire.mjs --remote after a real commit/push",
    );
    skip(
      "Hosted search",
      "run node .agents/entire.mjs --remote; login and indexing are separate from capture",
    );
  } else {
    check("Graph query", () => {
      const graph = json("entire", [
        "graph",
        "health",
        "--repo",
        ".",
        "--json",
      ]);
      assert.ok(graph.counts.symbols > 0);
      const query = json("entire", [
        "graph",
        "query",
        "--head",
        "--query",
        "WorkspaceServer",
        "--format",
        "json",
      ]);
      assert.ok(
        query.results.some(
          (result) => result.symbol_name === "WorkspaceServer",
        ),
      );
      return `${graph.counts.symbols} symbols; ${graph.counts.partial_failures} parser limitations`;
    });
    check("Checkpoint upload", () => {
      safeOrigin();
      privateRepository();
      const message = run("git", ["log", "-1", "--format=%B"]);
      const id = /^Entire-Checkpoint: (\S+)/m.exec(message)?.[1];
      assert.ok(id);
      const ref = `refs/entire/checkpoints/${id.slice(-2)}/${id}`;
      const stored = run("git", ["rev-parse", ref]);
      const transcript = run("entire", [
        "checkpoint",
        "explain",
        id,
        "--transcript",
      ]);
      assert.ok(
        transcript.includes("apply_patch") || transcript.includes("tool_use"),
      );
      assert.ok(
        run("git", ["ls-remote", checkpointURL, ref]).startsWith(`${stored}\t`),
      );
      assert.equal(run("git", ["ls-remote", "origin", ref]), "");
      return `${id}: readable transcript; matching private ref; absent from public origin`;
    });
    check("Hosted search", () => {
      assert.equal(
        json("entire", ["auth", "status", "--json"]).logged_in,
        true,
      );
      const found = json("entire", [
        "search",
        "Entire",
        "--repo",
        "cashew-labs/halo",
        "--compact",
        "--limit",
        "1",
      ]);
      assert.ok(Array.isArray(found) ? found.length : found.results?.length);
      return "query returned indexed results (not proof this push is indexed)";
    });
    check("Brain retrieval", () => {
      const brainPath = run("entire", ["brain", "path"]);
      const manifest = JSON.parse(
        fs.readFileSync(path.join(brainPath, "manifest.json")),
      );
      const message = run("git", ["log", "-1", "--format=%B"]);
      const id = /^Entire-Checkpoint: (\S+)/m.exec(message)?.[1];
      const session = manifest.sessions.find(
        (session) => session.latest_checkpoint_id === id,
      );
      assert.ok(session);
      const metadata = json("git", [
        "show",
        `refs/entire/checkpoints/${id.slice(-2)}/${id}:${session.session_index}/metadata.json`,
      ]);
      const start = metadata.checkpoint_transcript_start ?? 0;
      assert.ok(Number.isInteger(start));
      // A continued session may have no new prompt.txt at this checkpoint.
      const transcript = run("entire", [
        "checkpoint",
        "explain",
        id,
        "--session-index",
        String(session.session_index),
        "--transcript",
      ]);
      const probe = transcript
        .split("\n")
        .filter(Boolean)
        .slice(start)
        .flatMap((line) => JSON.parse(line).message?.content ?? [])
        .filter((block) => block.type === "text")
        .flatMap((block) => block.text.split("\n"))
        .map((line) =>
          line.length > 64 ? line.slice(0, 64).replace(/\S+$/, "") : line,
        )
        .find((line) => line.trim().length >= 40 && /[A-Za-z]{6,}/.test(line));
      if (!probe) {
        return {
          state: "not verified",
          detail:
            "checkpoint has no sufficiently long searchable text; cannot probe new evidence",
        };
      }
      const query = probe
        .match(/[A-Za-z]{6,}/g)
        ?.sort((a, b) => b.length - a.length)
        .slice(0, 3)
        .join(" ");
      assert.ok(query);
      const evidence = json("entire", [
        "brain",
        "query",
        query,
        "--source",
        "conversation",
        "--session",
        session.session_id,
        "--limit",
        "5",
        "--json",
      ]);
      const match = evidence.results.find(
        (result) =>
          result.path.toLowerCase().includes(id.toLowerCase()) &&
          result.end_line > start &&
          result.text.includes(probe),
      );
      assert.ok(match);
      // Exchange IDs can collide across cumulative checkpoint copies in Brain 0.4.
      // Session refs select the exact checkpoint's outline instead.
      const expanded = json("entire", [
        "brain",
        "get",
        match.session_ref,
        "--json",
      ]);
      assert.ok(
        expanded.results.some(
          (result) => result.session_ref === match.session_ref,
        ),
      );
      return "latest checkpoint: new text matches captured source; checkpoint-specific session expanded";
    });
  }
  if (
    Object.entries(results).some(
      ([name, result]) =>
        (remote ||
          [
            "Privacy boundary",
            "Local capture (offline fixture)",
            "Graph binary",
            "Brain binary",
          ].includes(name)) &&
        result.state === "unavailable",
    )
  ) {
    process.exitCode = 1;
  }
}
if (process.argv.includes("--watch")) {
  while (true) {
    refresh();
    await setTimeout(300_000);
  }
} else if (process.argv.includes("--refresh")) {
  refresh();
  if (Object.values(results).some((result) => result.state !== "verified"))
    process.exitCode = 1;
} else {
  health(process.argv.includes("--remote"));
}
