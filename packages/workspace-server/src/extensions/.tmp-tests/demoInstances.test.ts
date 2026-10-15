import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { once } from "node:events";
import { expect, test } from "vitest";
import { AppSandbox } from "../AppSandbox.js";
import { DemoBusyError, DemoInstances } from "../DemoInstances.js";
import { buildBooksArtifact, startSupervisor, writeLocalExtension } from "./appFixtures.js";

test("a restarted server reclaims demo instances an earlier process left running", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/extension-sharing");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "demo-"));
  const supervisor = await startSupervisor(root);
  try {
    await writeLocalExtension({ workspaceRoot: root, id: "demo-books", artifact: { ...(await buildBooksArtifact()), data: '{"sample":true}' } });
    const sandbox = new AppSandbox({ socketPath: supervisor.socketPath });
    const start = () => new DemoInstances({ sandbox, extensionId: "demo-books", brokerPort: 1, syncAccess: "read-only", limit: 2 });
    const crashed = start();
    for (const viewer of ["first", "second"]) {
      const instance = await crashed.connect(viewer);
      if (instance instanceof Error) throw instance;
    }
    expect(supervisor.running()).toHaveLength(2);
    // The earlier process exited without stop(); the new one starts empty.
    const restarted = start();
    const fresh = await restarted.connect("third");
    if (fresh instanceof Error) throw fresh;
    expect(supervisor.running()).toHaveLength(1);
    expect(await fs.readdir(path.join(supervisor.dataDirectory("demo-books"), "instances"))).toHaveLength(1);
    // Reclaiming happens once per process, not on every visitor.
    const again = await restarted.connect("fourth");
    if (again instanceof Error) throw again;
    expect(supervisor.running()).toHaveLength(2);
    await restarted.stop();
  } finally {
    await supervisor.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("a host that cannot reclaim demo instances refuses new visitors", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/extension-sharing");
  await fs.mkdir(parent, { recursive: true });
  const socketPath = path.relative(process.cwd(), path.join(parent, `reset-${process.pid}`));
  await fs.rm(socketPath, { force: true });
  const host = http.createServer((_request, response) => response.end("{}"));
  host.listen(socketPath);
  await once(host, "listening");
  try {
    const invalid = new DemoInstances({ sandbox: new AppSandbox({ socketPath }), extensionId: "demo-books", brokerPort: 1, syncAccess: "read-only" });
    expect(await invalid.connect("visitor")).toMatchObject({ message: "App sandbox failed: invalid reset response" });
    const missing = new DemoInstances({ sandbox: new AppSandbox({ socketPath: `${socketPath}-missing` }), extensionId: "demo-books", brokerPort: 1, syncAccess: "read-only" });
    expect(await missing.connect("visitor")).toBeInstanceOf(Error);
  } finally {
    await new Promise((resolve) => host.close(resolve));
    await fs.rm(socketPath, { force: true });
  }
});

test("a burst of new visitors cannot evict demos in use, and running demos answer while another starts", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/extension-sharing");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "demo-busy-"));
  const supervisor = await startSupervisor(root);
  try {
    await writeLocalExtension({ workspaceRoot: root, id: "demo-books", artifact: { ...(await buildBooksArtifact()), data: '{"sample":true}' } });
    const demos = new DemoInstances({ sandbox: new AppSandbox({ socketPath: supervisor.socketPath }), extensionId: "demo-books", brokerPort: 1, syncAccess: "read-only", limit: 2, idleMs: 400 });
    const first = await demos.connect("first");
    if (first instanceof Error) throw first;
    const second = await demos.connect("second");
    if (second instanceof Error) throw second;
    for (const viewer of ["burst-1", "burst-2", "burst-3"])
      expect(await demos.connect(viewer)).toBeInstanceOf(DemoBusyError);
    expect(supervisor.running()).toHaveLength(2);
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(await demos.connect("second")).toBe(second);
    // "first" is idle now; a new visitor replaces it while "second" keeps answering.
    const order: string[] = [];
    const third = demos.connect("third").then((instance) => { order.push("third"); return instance; });
    const again = demos.connect("second").then((instance) => { order.push("second"); return instance; });
    expect(await again).toBe(second);
    expect(await third).not.toBeInstanceOf(Error);
    expect(order).toEqual(["second", "third"]);
    expect(supervisor.running()).toHaveLength(2);
    await demos.stop();
  } finally {
    await supervisor.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("concurrent first requests of one visitor share one demo instance", async () => {
  const parent = path.resolve(import.meta.dirname, "../../../../../tmp/extension-sharing");
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, "demo-same-"));
  const supervisor = await startSupervisor(root);
  try {
    await writeLocalExtension({ workspaceRoot: root, id: "demo-books", artifact: { ...(await buildBooksArtifact()), data: '{"sample":true}' } });
    const demos = new DemoInstances({ sandbox: new AppSandbox({ socketPath: supervisor.socketPath }), extensionId: "demo-books", brokerPort: 1, syncAccess: "read-only" });
    const [first, second] = await Promise.all([demos.connect("same"), demos.connect("same")]);
    if (first instanceof Error) throw first;
    expect(second).toBe(first);
    expect(supervisor.running()).toHaveLength(1);
    await demos.stop();
  } finally {
    await supervisor.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
