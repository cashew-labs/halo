import { test, expect, vi } from "vitest";
import * as errore from "errore";
import * as pulumi from "@pulumi/pulumi";

const infraTest = test.extend<{ resources: pulumi.runtime.MockResourceArgs[] }>(
  {
    resources: async ({}, use) => {
      await using cleanup = new errore.AsyncDisposableStack();
      cleanup.defer(async () => await pulumi.runtime.disconnect());
      vi.resetModules();
      const resources: pulumi.runtime.MockResourceArgs[] = [];
      await pulumi.runtime.setMocks(
        {
          newResource(args) {
            resources.push(args);
            return {
              id: `${args.name}-id`,
              state: {
                ...args.inputs,
                name: args.inputs.name ?? args.name,
                email: `${args.name}@halo.test`,
                selfLink: `https://fixture/${args.name}`,
                privateIpAddress: "10.0.0.1",
                result: "fixture-password",
                ipv4Address: "127.0.0.1",
              },
            };
          },
          call(args) {
            return args.inputs;
          },
        },
        "halo-control-plane",
        "test",
        false,
      );
      pulumi.runtime.setAllConfig({
        "gcp:project": "halo-relay",
        "gcp:region": "us-west2",
        "gcp:zone": "us-west2-a",
        "halo-control-plane:controlPlaneImage": "fixture-control-plane",
        "halo-control-plane:workspaceImage": "fixture-workspace",
        "halo-control-plane:deploymentServiceAccount": "deploy@halo.test",
        "halo-control-plane:controlPlaneDomain": "halo.test",
      });
      await use(resources);
    },
  },
);

for (const configured of [false, true]) {
  infraTest(
    `registers GitHub credentials only when configured: ${configured}`,
    async ({ resources }) => {
      if (configured) {
        pulumi.runtime.setConfig(
          "halo-control-plane:githubClientIdSecretId",
          "github-id",
        );
        pulumi.runtime.setConfig(
          "halo-control-plane:githubClientSecretId",
          "github-secret",
        );
      }
      await pulumi.runtime.runInPulumiStack(
        async () => await import("../index.js"),
      );
      const service = resources.find(
        (resource) =>
          resource.type === "gcp:cloudrunv2/service:Service" &&
          resource.name === "control-plane-service",
      )!;
      expect(service).toBeDefined();
      const template = service.inputs.template;
      const githubEnv = template.containers[0].envs.filter(
        (env: { name: string }) => env.name.startsWith("GITHUB_"),
      );
      const githubGrants = resources.filter(
        (resource) =>
          resource.type ===
            "gcp:secretmanager/secretIamMember:SecretIamMember" &&
          resource.name.startsWith("github-oauth-"),
      );
      expect(githubGrants.map((grant) => grant.inputs.secretId).sort()).toEqual(
        configured ? ["github-id", "github-secret"] : [],
      );
      expect(githubEnv).toEqual(
        configured
          ? [
              { name: "GITHUB_CLIENT_ID_SECRET_ID", value: "github-id" },
              { name: "GITHUB_CLIENT_SECRET_ID", value: "github-secret" },
            ]
          : [],
      );
      for (const grant of githubGrants)
        expect(grant.inputs.role).toBe("roles/secretmanager.secretAccessor");
    },
  );
}
for (const key of ["githubClientIdSecretId", "githubClientSecretId"]) {
  infraTest(
    `rejects partial deployment credentials: ${key}`,
    async ({ resources }) => {
      pulumi.runtime.setConfig(`halo-control-plane:${key}`, "only-one-secret");
      await expect(import("../index.js")).rejects.toThrow(
        "Set both githubClientIdSecretId and githubClientSecretId",
      );
      expect(
        resources.filter((resource) =>
          resource.name.startsWith("github-oauth-"),
        ),
      ).toHaveLength(0);
    },
  );
}
