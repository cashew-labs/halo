import * as pulumi from "@pulumi/pulumi";
import { beforeEach, expect, test, vi } from "vitest";

type Created = { type: string; name: string; inputs: Record<string, unknown> };
let created: Created[];

const baseConfig = {
  "gcp:project": "halo-relay",
  "gcp:region": "us-west2",
  "gcp:zone": "us-west2-a",
  "halo-control-plane:deploymentServiceAccount":
    "halo-github-deploy@halo-relay.iam.gserviceaccount.com",
  "halo-control-plane:controlPlaneImage": "control-plane:test",
  "halo-control-plane:workspaceImage": "workspace-server:test",
  "halo-control-plane:workspaceProvider": "exe",
  "halo-control-plane:exeTemplateVmName": "halo-exe-template",
  "halo-control-plane:exePrivateKeySecretId": "halo-west-exe-account-key",
  "halo-control-plane:exeGatewaySecretId": "gateway-seed",
};

async function runStack(
  stack: string,
  config: Record<string, string>,
  omit: string[] = [],
) {
  vi.resetModules();
  created = [];
  await pulumi.runtime.setMocks(
    {
      newResource: (args) => {
        created.push({ type: args.type, name: args.name, inputs: args.inputs });
        return {
          id: `${args.name}-id`,
          state: {
            ...args.inputs,
            email: `${args.name}@example.com`,
            connectionName: `${args.name}-connection`,
            address: "203.0.113.1",
            selfLink: `${args.name}-link`,
          },
        };
      },
      call: () => ({}),
    },
    "halo-control-plane",
    stack,
    false,
  );
  const merged: Record<string, string> = { ...baseConfig, ...config };
  for (const key of omit) delete merged[key];
  pulumi.runtime.setAllConfig(merged);
  const outputs = await import("../control-plane/index.js");
  return outputs;
}

function resources(type: string) {
  return created.filter((resource) => resource.type === type);
}

async function value<T>(output: pulumi.Output<T> | T | undefined) {
  if (output === undefined) return undefined;
  return await new Promise<T>((resolve) =>
    pulumi.output(output).apply((resolved) => {
      resolve(resolved);
      return resolved;
    }),
  );
}

beforeEach(() => {
  created = [];
});

test("a stack without imageRepositoryId owns its image build resources", async () => {
  const outputs = await runStack("west", {
    "halo-control-plane:controlPlaneDomain": "gethalo.dev",
  });
  await value(outputs.controlPlaneName);

  expect(resources("gcp:artifactregistry/repository:Repository")).toHaveLength(1);
  expect(resources("gcp:storage/bucket:Bucket").map((r) => r.name)).toContain(
    "build-sources",
  );
  const reader = resources(
    "gcp:artifactregistry/repositoryIamMember:RepositoryIamMember",
  ).find((r) => r.name === "workspace-image-reader");
  expect(reader?.inputs.repository).toBe("halo-west-workspaces");
  expect(await value(outputs.buildSourceBucket)).toBe(
    "halo-relay-halo-west-build-sources",
  );
});

test("a stack with imageRepositoryId reads the shared repository", async () => {
  const outputs = await runStack("prod", {
    "halo-control-plane:controlPlaneDomain": "gethalo.dev",
    "halo-control-plane:imageRepositoryId": "halo-west-workspaces",
  });
  await value(outputs.controlPlaneName);

  expect(resources("gcp:artifactregistry/repository:Repository")).toHaveLength(0);
  expect(
    resources("gcp:storage/bucket:Bucket").map((r) => r.name),
  ).not.toContain("build-sources");
  expect(
    resources("gcp:serviceaccount/account:Account").map((r) => r.name),
  ).not.toContain("builder");
  const reader = resources(
    "gcp:artifactregistry/repositoryIamMember:RepositoryIamMember",
  ).find((r) => r.name === "workspace-image-reader");
  expect(reader?.inputs.repository).toBe("halo-west-workspaces");
  expect(await value(outputs.imageRepository)).toBe(
    "us-west2-docker.pkg.dev/halo-relay/halo-west-workspaces/workspace-server",
  );
  expect(outputs.buildSourceBucket).toBeUndefined();
  expect(outputs.buildServiceAccount).toBeUndefined();
});

test("apex domains serve and redirect www by default", async () => {
  await runStack("prod", {
    "halo-control-plane:controlPlaneDomain": "gethalo.dev",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const certificate = resources(
    "gcp:certificatemanager/certificate:Certificate",
  )[0];
  expect(certificate?.inputs.managed).toEqual({
    domains: ["gethalo.dev", "www.gethalo.dev"],
  });
  expect(
    resources("gcp:certificatemanager/certificateMapEntry:CertificateMapEntry")
      .map((r) => r.inputs.hostname)
      .sort(),
  ).toEqual(["gethalo.dev", "www.gethalo.dev"]);
  const https = resources("gcp:compute/uRLMap:URLMap").find(
    (r) => r.name === "control-plane-https-routes",
  );
  expect(https?.inputs.hostRules).toEqual([
    { hosts: ["www.gethalo.dev"], pathMatcher: "redirect-www" },
  ]);
});

test("redirectWww false serves only the configured subdomain", async () => {
  await runStack("west", {
    "halo-control-plane:controlPlaneDomain": "staging.gethalo.dev",
    "halo-control-plane:redirectWww": "false",
  });
  await new Promise((resolve) => setTimeout(resolve, 50));

  const certificate = resources(
    "gcp:certificatemanager/certificate:Certificate",
  )[0];
  expect(certificate?.inputs.managed).toEqual({
    domains: ["staging.gethalo.dev"],
  });
  expect(
    resources(
      "gcp:certificatemanager/certificateMapEntry:CertificateMapEntry",
    ).map((r) => r.inputs.hostname),
  ).toEqual(["staging.gethalo.dev"]);
  const https = resources("gcp:compute/uRLMap:URLMap").find(
    (r) => r.name === "control-plane-https-routes",
  );
  expect(https?.inputs.hostRules ?? []).toEqual([]);
  expect(https?.inputs.pathMatchers ?? []).toEqual([]);
});

const deploymentBindings = [
  "deployment-logging-config",
  "deployment-pubsub-admin",
  "deployment-workspace-os-login",
  "deployment-workspace-iap",
  "exe-release-key-access",
];

function controlPlaneEnv(name: string) {
  const service = resources("gcp:cloudrunv2/service:Service")[0];
  // SAFETY: the mock records the Cloud Run inputs as plain JSON.
  const template = service?.inputs.template as {
    containers: { envs: { name: string; value: unknown }[] }[];
  };
  return template.containers[0]?.envs.find((env) => env.name === name)?.value;
}

test("west owns the deployment grants and uses its configured gateway seed", async () => {
  const outputs = await runStack("west", {
    "halo-control-plane:controlPlaneDomain": "gethalo.dev",
  });
  await value(outputs.controlPlaneName);

  const names = created.map((r) => r.name);
  for (const binding of deploymentBindings) expect(names).toContain(binding);
  expect(names).not.toContain("exe-gateway-seed");
  expect(controlPlaneEnv("EXE_GATEWAY_SECRET_ID")).toBe("gateway-seed");
  expect(controlPlaneEnv("GOOGLE_CLIENT_ID_SECRET_ID")).toBe(
    "halo-west-control-plane-google-client-id",
  );
});

test("prod shares sign-in secrets, skips deployment grants, and generates a gateway seed", async () => {
  const outputs = await runStack(
    "prod",
    {
      "halo-control-plane:controlPlaneDomain": "gethalo.dev",
      "halo-control-plane:imageRepositoryId": "halo-west-workspaces",
      "halo-control-plane:googleClientIdSecretId":
        "halo-west-control-plane-google-client-id",
      "halo-control-plane:googleClientSecretId":
        "halo-west-control-plane-google-client-secret",
      "halo-control-plane:ownsDeploymentAccess": "false",
    },
    ["halo-control-plane:exeGatewaySecretId"],
  );
  await value(outputs.controlPlaneName);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const names = created.map((r) => r.name);
  for (const binding of deploymentBindings)
    expect(names).not.toContain(binding);

  const seed = resources("gcp:secretmanager/secret:Secret").find(
    (r) => r.name === "exe-gateway-seed",
  );
  expect(seed?.inputs.secretId).toBe("halo-prod-exe-gateway-seed");
  expect(names).toContain("exe-gateway-seed-version");
  expect(await value(controlPlaneEnv("EXE_GATEWAY_SECRET_ID"))).toBe(
    "halo-prod-exe-gateway-seed",
  );
  const gatewayAccess = resources(
    "gcp:secretmanager/secretIamMember:SecretIamMember",
  ).find((r) => r.name === "exe-secret-access-1");
  expect(gatewayAccess?.inputs.secretId).toBe("halo-prod-exe-gateway-seed");

  expect(controlPlaneEnv("GOOGLE_CLIENT_ID_SECRET_ID")).toBe(
    "halo-west-control-plane-google-client-id",
  );
  expect(controlPlaneEnv("GOOGLE_CLIENT_SECRET_ID")).toBe(
    "halo-west-control-plane-google-client-secret",
  );
  const clientAccess = resources(
    "gcp:secretmanager/secretIamMember:SecretIamMember",
  ).find((r) => r.name === "google-client-id-access");
  expect(clientAccess?.inputs.secretId).toBe(
    "halo-west-control-plane-google-client-id",
  );
});
