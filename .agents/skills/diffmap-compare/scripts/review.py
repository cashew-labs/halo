#!/usr/bin/env python3
"""Run two separately maintained Diffmap review variants."""
import argparse
import hashlib
import json
from pathlib import Path
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request

SKILL = Path(__file__).resolve().parents[1]
VERSIONS = json.loads((SKILL / "assets/versions.json").read_text())
PATCH = SKILL / "assets/custom.patch"
UPSTREAM_PATCH = SKILL / "assets/upstream.patch"


def run(*args, cwd=None, capture=False):
    result = subprocess.run(args, cwd=cwd, check=True, capture_output=capture)
    return result.stdout if capture else None


def git(directory, *args):
    return run("git", "-C", str(directory), *args, capture=True)


def read_json(path):
    return json.loads(path.read_text()) if path.exists() else {}


def write_json(path, value):
    path.write_text(json.dumps(value, indent=2) + "\n")


def install(directory, state, name):
    digest = hashlib.sha256((directory / "package-lock.json").read_bytes()).hexdigest()
    if state.get(name) != digest or not (directory / "node_modules").exists():
        run("npm", "ci", "--no-audit", "--no-fund", cwd=directory)
        state[name] = digest


def sync(runtime):
    runtime.mkdir(parents=True, exist_ok=True)
    upstream = runtime / "upstream"
    upstream_base = VERSIONS.get("upstreamBase")
    if upstream_base:
        if not upstream.exists():
            run("git", "clone", "--no-checkout", VERSIONS["repository"], str(upstream))
            run("git", "-C", str(upstream), "fetch", "origin", upstream_base)
            run("git", "-C", str(upstream), "checkout", "--detach", upstream_base)
            run("git", "-C", str(upstream), "apply", str(UPSTREAM_PATCH))
            run("git", "-C", str(upstream), "add", "--intent-to-add", ".")
        if git(upstream, "rev-parse", "HEAD").decode().strip() != upstream_base:
            raise RuntimeError("Version 1 checkout is not at its pinned base; preserve it before syncing.")
        if git(upstream, "diff", "--binary", upstream_base) != UPSTREAM_PATCH.read_bytes():
            raise RuntimeError("Version 1 differs from its saved patch. Use capture-upstream to preserve intentional edits.")
    else:
        if not upstream.exists():
            run("git", "clone", VERSIONS["repository"], str(upstream))
        if git(upstream, "status", "--porcelain").strip():
            raise RuntimeError(f"Upstream checkout has local changes: {upstream}. Preserve them before syncing.")
        run("git", "-C", str(upstream), "fetch", "origin", VERSIONS["upstreamBranch"])
        run("git", "-C", str(upstream), "checkout", "--detach", "FETCH_HEAD")
    custom = runtime / "custom"
    if not custom.exists():
        run("git", "clone", "--no-checkout", VERSIONS["repository"], str(custom))
        run("git", "-C", str(custom), "fetch", "origin", VERSIONS["customBase"])
        run("git", "-C", str(custom), "checkout", "--detach", VERSIONS["customBase"])
        run("git", "-C", str(custom), "apply", str(PATCH))
        run("git", "-C", str(custom), "add", "--intent-to-add", ".")
    if git(custom, "diff", "--binary", VERSIONS["customBase"]) != PATCH.read_bytes():
        raise RuntimeError(f"Custom checkout differs from the saved patch: {custom}. Use capture-custom to preserve intentional edits; sync never overwrites them.")
    dependencies = read_json(runtime / "dependencies.json")
    install(upstream, dependencies, "upstream")
    install(custom, dependencies, "custom")
    write_json(runtime / "dependencies.json", dependencies)
    result = {
        "upstreamCommit": git(upstream, "rev-parse", "HEAD").decode().strip(),
        "upstreamSkill": str(upstream / "skills/code-walkthrough/SKILL.md"),
        "upstreamPatchSha256": hashlib.sha256(UPSTREAM_PATCH.read_bytes()).hexdigest() if upstream_base else None,
        "customBase": VERSIONS["customBase"],
        "customInstructions": str(SKILL / "references/custom.md"),
        "customPatchSha256": hashlib.sha256(PATCH.read_bytes()).hexdigest(),
    }
    write_json(runtime / "versions.json", result)
    print(json.dumps(result, indent=2))


def occupied(port):
    with socket.socket() as connection:
        connection.settimeout(0.3)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def metadata(url, prefix):
    try:
        with urllib.request.urlopen(f"{url}/{prefix}/meta", timeout=1) as response:
            return json.load(response)
    except (OSError, ValueError):
        return None


def owned(entry):
    meta = metadata(entry["url"], entry["prefix"])
    return meta is not None and meta.get("pid") == entry["pid"] and meta.get("file") == entry["file"]


def stop_entry(entry):
    if not owned(entry):
        return
    request = urllib.request.Request(f'{entry["url"]}/{entry["prefix"]}/shutdown', method="POST")
    with urllib.request.urlopen(request, timeout=3) as response:
        response.read()
    deadline = time.monotonic() + 5
    while occupied(entry["port"]) and time.monotonic() < deadline:
        time.sleep(0.1)
    if occupied(entry["port"]):
        raise RuntimeError(f'Server did not stop: {entry["url"]}')


def serve(args, runtime):
    revisions = read_json(runtime / "versions.json")
    if not revisions:
        raise RuntimeError("Run sync first, then author the two documents using the printed instruction paths.")
    state_path = runtime / "servers.json"
    state = read_json(state_path)
    plans = [
        ("upstream", args.upstream, args.upstream_port, "__diffmap"),
        ("custom", args.custom, args.custom_port, "__tkstack"),
    ]
    if args.upstream_port == args.custom_port:
        raise RuntimeError("The variants need different ports.")
    root = str(args.root.resolve())
    # Preflight both ports before replacing either owned server.
    for name, document, port, prefix in plans:
        if not document.is_file():
            raise RuntimeError(f"Missing {name} document: {document}")
        previous = state.get(name)
        if occupied(port) and not (previous and previous["port"] == port and owned(previous)):
            raise RuntimeError(f"Port {port} is occupied by a server this launcher does not own. Stop that server or choose another port.")
    started = []
    try:
        for name, document, port, prefix in plans:
            document = str(document.resolve())
            previous = state.get(name)
            revision = (revisions.get("upstreamPatchSha256") or revisions["upstreamCommit"]) if name == "upstream" else revisions["customPatchSha256"]
            if previous and owned(previous):
                if previous["file"] == document and previous["root"] == root and previous["port"] == port and previous["revision"] == revision:
                    continue
                stop_entry(previous)
            log_path = runtime / f"{name}.log"
            command = ["node", str(runtime / name / "bin.js")]
            if name == "upstream":
                command.append("serve")
            command.extend([document, "--root", root, "--port", str(port)])
            with log_path.open("ab") as log:
                process = subprocess.Popen(command, cwd=args.workspace, stdin=subprocess.DEVNULL, stdout=log, stderr=log, start_new_session=True)
            entry = {"pid": process.pid, "file": document, "root": root, "port": port, "url": f"http://127.0.0.1:{port}", "prefix": prefix, "revision": revision, "log": str(log_path)}
            started.append((process, entry))
            deadline = time.monotonic() + 45
            while not owned(entry):
                if process.poll() is not None or time.monotonic() > deadline:
                    raise RuntimeError(f"{name} did not become ready. See {log_path}")
                time.sleep(0.2)
            state[name] = entry
            write_json(state_path, state)
    except Exception:
        # These are the children created by this invocation, never arbitrary port owners.
        for process, entry in started:
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=5)
            state.pop("upstream" if entry["prefix"] == "__diffmap" else "custom", None)
        write_json(state_path, state)
        raise
    print(json.dumps({name: {"url": state[name]["url"], "file": state[name]["file"]} for name, *_ in plans}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--workspace", type=Path, default=Path.cwd(), help="Project workspace; runtime checkouts/logs live under its tmp/diffmap-compare directory")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("sync", help="Prepare separately pinned review variants and install locked dependencies")
    start = commands.add_parser("serve", help="Serve separately authored upstream and custom documents; reuse matching servers")
    start.add_argument("upstream", type=Path)
    start.add_argument("custom", type=Path)
    start.add_argument("--root", type=Path, default=Path.cwd(), help="Source workspace for both viewers")
    start.add_argument("--upstream-port", type=int, default=VERSIONS["upstreamPort"])
    start.add_argument("--custom-port", type=int, default=VERSIONS["customPort"])
    commands.add_parser("status")
    commands.add_parser("stop", help="Stop only this launcher's recorded servers")
    commands.add_parser("capture-upstream", help="Save intentional version 1 edits into assets/upstream.patch")
    commands.add_parser("capture-custom", help="Save intentional custom viewer changes back into assets/custom.patch")
    args = parser.parse_args()
    args.workspace = args.workspace.resolve()
    runtime = args.workspace / "tmp/diffmap-compare"
    if args.command == "sync":
        sync(runtime)
    elif args.command == "serve":
        serve(args, runtime)
    elif args.command in ("capture-custom", "capture-upstream"):
        name = "custom" if args.command == "capture-custom" else "upstream"
        checkout = runtime / name
        base = VERSIONS["customBase" if name == "custom" else "upstreamBase"]
        patch = PATCH if name == "custom" else UPSTREAM_PATCH
        run("git", "-C", str(checkout), "add", "--intent-to-add", ".")
        patch.write_bytes(git(checkout, "diff", "--binary", base))
        revisions = read_json(runtime / "versions.json")
        revisions[f"{name}PatchSha256"] = hashlib.sha256(patch.read_bytes()).hexdigest()
        write_json(runtime / "versions.json", revisions)
        print(f"Saved {patch}. The other variant is unchanged.")
    else:
        state = read_json(runtime / "servers.json")
        if args.command == "stop":
            for entry in state.values():
                stop_entry(entry)
            write_json(runtime / "servers.json", {})
        else:
            print(json.dumps({name: {**entry, "running": owned(entry)} for name, entry in state.items()}, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        sys.exit(str(error))
