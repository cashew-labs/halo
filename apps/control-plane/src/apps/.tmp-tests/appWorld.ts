import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import { test } from "vitest";
import { createHaloClient, type ExtensionArtifact } from "@get-halo/client";
import { Logger } from "@get-halo/logger";
import { WorkspaceServer } from "@get-halo/workspace-server";
import { createOpenAILLMApi } from "@get-halo/workspace-server/llm";
import { LLMDriver } from "@get-halo/workspace-server/testing";
import { togetherModel } from "@get-halo/config/inference";
import type { ControlPlaneClient } from "@get-halo/shared/controlPlaneContract";
import { ControlPlane } from "../../server/ControlPlane.js";
import type {
  WorkspaceProviderApi,
  WorkspaceProviderAssignment,
  WorkspaceProviderInput,
} from "../../workspace/provider/WorkspaceProviderApi.js";
import {
  buildBooksArtifact,
  startSupervisor,
  writeLocalExtension,
  type Supervisor,
} from "../../../../../packages/workspace-server/src/extensions/.tmp-tests/appFixtures.js";

export const testAuth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};

type Vm = { server: WorkspaceServer; gateway: string; root: string; assignment: WorkspaceProviderAssignment; supervisor: Supervisor | undefined };

/**
 * Exe stand-in: each ensure starts a real workspace server, the owner's VM or a
 * dedicated app VM. App VMs reach their backend through the supervisor fixture.
 */
export class VmProvider implements WorkspaceProviderApi {
  readonly vms = new Map<string, Vm>();
  readonly assignments: WorkspaceProviderAssignment[] = [];
  failAppEnsures = 0;
  // Exe hosts app VMs; set undefined to act like the Local and GCP providers.
  hostsSharedApps: true | undefined = true;
  // App VM provisioning for these owners waits until the promise settles.
  readonly heldOwners = new Map<string, Promise<void>>();
  // Workspace IDs whose connection is not available yet, like a VM still booting.
  readonly unreachable = new Set<string>();
  appsUnreachable = false;
  // App VMs that exist but whose server does not answer.
  appsBroken = false;
  readonly removed: string[] = [];
  // Connections that point at a closed port, like a VM whose server crashed.
  readonly brokenOrigins = new Set<string>();
  // Exit codes for build commands on the next app VM created.
  readonly buildExitCodes: number[] = [];
  private readonly supervisors: Supervisor[] = [];

  constructor(private readonly ctx: { root: string; seed: (root: string) => Promise<void>; llm: LLMDriver }) {}

  async ensure(input: WorkspaceProviderAssignment) {
    this.assignments.push(input);
    if (input.sharedApp !== undefined && this.failAppEnsures > 0) {
      this.failAppEnsures -= 1;
      return new Error("app VM provisioning interrupted");
    }
    if (input.sharedApp !== undefined) await this.heldOwners.get(input.ownerUserId);
    if (this.vms.has(input.workspaceId)) return;
    const root = path.join(this.ctx.root, `vm-${input.workspaceId}`);
    await fs.mkdir(path.join(root, "workspace"), { recursive: true });
    if (input.sharedApp === undefined) await this.ctx.seed(path.join(root, "workspace"));
    const supervisor = input.sharedApp === undefined ? undefined : await startSupervisor(path.join(root, "workspace"));
    if (supervisor !== undefined) {
      this.supervisors.push(supervisor);
      supervisor.exitCodes.push(...this.buildExitCodes.splice(0));
    }
    const gateway = `gateway-${input.workspaceId}-token-with-enough-length`;
    const runtime = createControlPlaneRpcClient(input.runtime.origin, input.runtime.token);
    const server = await WorkspaceServer.start({
      config: {
        environment: "local",
        workspaceRoot: path.join(root, "workspace"),
        appDataDir: path.join(root, "data"),
        appVersion: "test",
        ownerUserId: input.ownerUserId,
        host: "127.0.0.1",
        port: 0,
        corsOrigins: [],
        gateway: { token: gateway },
        sharedApp: input.sharedApp,
        extensionRuntime: { executable: process.execPath, electronRunAsNode: false, ...(supervisor === undefined ? {} : { sandbox: { socketPath: supervisor.socketPath } }) },
      },
      host: {
        // App VMs reach the model through the control plane in production; the
        // driver stands in for that upstream so conversations run for real.
        llmApi: input.sharedApp === undefined ? createOpenAILLMApi({ model: togetherModel, apiKey: "unused", reasoning: "low" }) : createOpenAILLMApi({ ...this.ctx.llm.configuration, model: { ...this.ctx.llm.configuration.model, compat: togetherModel.compat } }),
        logger: new Logger({ sinks: [] }),
        remoteApps: input.sharedApp === undefined ? runtime.apps : undefined,
      },
    });
    if (server instanceof Error) return server;
    this.vms.set(input.workspaceId, { server, gateway, root, assignment: input, supervisor });
  }

  async getConnection(input: WorkspaceProviderInput) {
    const vm = this.vms.get(input.workspaceId);
    if (vm === undefined || this.unreachable.has(input.workspaceId)) return undefined;
    if (this.appsUnreachable && vm.assignment.sharedApp !== undefined) return undefined;
    const port = this.brokenOrigins.has(input.workspaceId) || (this.appsBroken && vm.assignment.sharedApp !== undefined) ? 1 : vm.server.ready.connections.cli.port;
    return { origin: `http://127.0.0.1:${port}`, authorization: { type: "bearer" as const, value: `Bearer ${vm.gateway}` } };
  }

  async remove(input: WorkspaceProviderInput) {
    const vm = this.vms.get(input.workspaceId);
    if (vm === undefined) return;
    this.vms.delete(input.workspaceId);
    this.removed.push(input.workspaceId);
    await vm.server.close();
  }

  /** The VM's own local client, as a process on that VM would use it. */
  client(workspaceId: string) {
    const vm = this.vms.get(workspaceId);
    if (vm === undefined) throw new Error(`VM ${workspaceId} is not running`);
    const cli = vm.server.ready.connections.cli;
    return createHaloClient({ transport: { origin: `http://127.0.0.1:${cli.port}`, path: "/rpc", headers: { authorization: `Bearer ${cli.token}` } } });
  }

  ownerVm(ownerUserId?: string) {
    return [...this.vms.values()].find((vm) => vm.assignment.sharedApp === undefined && (ownerUserId === undefined || vm.assignment.ownerUserId === ownerUserId))!;
  }

  async close() {
    for (const vm of this.vms.values()) await vm.server.close();
    for (const supervisor of this.supervisors) await supervisor.close();
  }
}

export function createControlPlaneRpcClient(origin: string, token?: string | Headers) {
  const link = new RPCLink({
    origin,
    url: "/rpc",
    headers: token instanceof Headers ? token : token === undefined ? undefined : { authorization: `Bearer ${token}` },
  });
  // SAFETY: The control-plane origin serves controlPlaneContract at /rpc.
  return createORPCClient(link) as ControlPlaneClient;
}

export async function signIn(ctx: { appDataDir: string; origin: string; email: string }) {
  using database = new DatabaseSync(path.join(ctx.appDataDir, "control-plane.db"));
  const auth = betterAuth({ baseURL: ctx.origin, secret: testAuth.secret, database, plugins: [testUtils()] });
  const context = await auth.$context;
  const user = context.test.createUser({ email: ctx.email, name: ctx.email });
  await context.test.saveUser(user);
  const login = await context.test.login({ userId: user.id });
  const headers = new Headers(login.headers);
  headers.set("origin", ctx.origin);
  return { userId: user.id, headers, rpc: createControlPlaneRpcClient(ctx.origin, headers) };
}

export type AppWorld = {
  llm: LLMDriver;
  appDataDir: string;
  artifact: ExtensionArtifact;
  provider: VmProvider;
  plane: ControlPlane;
};

export const appWorldTest = test.extend<AppWorld & { integrationKey: Buffer | undefined } & { packageJson: object | undefined; router: string | undefined; liveData: string | undefined }>({
  packageJson: undefined,
  integrationKey: Buffer.alloc(32, 17),
  liveData: '{"owner":"live data"}',
  router: undefined,
  appDataDir: async ({ task }, use) => {
    const parent = path.resolve(import.meta.dirname, "../../../../../tmp/control-plane");
    await fs.mkdir(parent, { recursive: true });
    const appDataDir = await fs.mkdtemp(path.join(parent, `${task.id}-`));
    await use(appDataDir);
    await fs.rm(appDataDir, { recursive: true, force: true });
  },
  artifact: async ({ packageJson, router, liveData }, use) =>
    await use({ ...(await buildBooksArtifact({ packageJson, router })), data: liveData }),
  // oxlint-disable-next-line eslint/no-empty-pattern -- Native fixture signature.
  llm: async ({}, use) => {
    const llm = await LLMDriver.start();
    if (llm instanceof Error) throw llm;
    await use(llm);
    await llm.close();
  },
  provider: async ({ appDataDir, artifact, llm }, use) => {
    const provider = new VmProvider({
      llm,
      root: path.join(appDataDir, "vms"),
      seed: async (root) => await writeLocalExtension({ workspaceRoot: root, id: "books", artifact }),
    });
    await use(provider);
    await provider.close();
  },
  plane: async ({ appDataDir, provider, integrationKey }, use) => {
    const webRoot = path.join(appDataDir, "web");
    await fs.mkdir(webRoot, { recursive: true });
    await fs.writeFile(path.join(webRoot, "index.html"), "<main>Halo</main>");
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir,
        port: 0,
        auth: testAuth,
        gmail: { topic: "projects/halo-test/topics/gmail", audience: "https://halo.test/api/automation-events/gmail", serviceAccount: "push@halo.test" },
      },
      webRoot,
      workspaceProvider: provider,
      integrationEncryptionKey: integrationKey,
      allowLocalIntegrationUrls: true,
      appReadyTimeoutMs: 5_000,
    });
    if (plane instanceof Error) throw plane;
    await use(plane);
    await plane.close();
  },
});
