import fs from "node:fs";
import path from "node:path";
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

function controlPlaneEnv(name: string) {
  const service = resources("gcp:cloudrunv2/service:Service")[0];
  // SAFETY: the mock records the Cloud Run inputs as plain JSON.
  const template = service?.inputs.template as {
    containers: { envs: { name: string; value: unknown }[] }[];
  };
  return template.containers[0]?.envs.find((env) => env.name === name)?.value;
}


test("prod lets its control plane read the staging testers secret and passes it on", async () => {
  const outputs = await runStack("prod", {
    "halo-control-plane:controlPlaneDomain": "gethalo.dev",
    "halo-control-plane:stagingTestersSecretId": "halo-west-sign-in-allowlist",
  });
  await value(outputs.controlPlaneName);
  const access = resources("gcp:secretmanager/secretIamMember:SecretIamMember").find(
    (r) => r.name === "staging-testers-access",
  );
  expect(access?.inputs.secretId).toBe("halo-west-sign-in-allowlist");
  expect(access?.inputs.role).toBe("roles/secretmanager.secretAccessor");
  expect(controlPlaneEnv("STAGING_TESTERS_SECRET_ID")).toBe("halo-west-sign-in-allowlist");
  // Testers only change the menu; production sign-in stays open.
  expect(controlPlaneEnv("SIGN_IN_ALLOWLIST_SECRET_ID")).toBeUndefined();
});

test("without the setting, no staging testers secret is granted or passed", async () => {
  const outputs = await runStack("west", {
    "halo-control-plane:controlPlaneDomain": "staging.gethalo.dev",
  });
  await value(outputs.controlPlaneName);
  expect(created.map((r) => r.name)).not.toContain("staging-testers-access");
  expect(controlPlaneEnv("STAGING_TESTERS_SECRET_ID")).toBeUndefined();
});

test("prod keeps its own sign-in allowlist and names the staging allowlist as its testers", () => {
  const prod = fs.readFileSync(path.join(import.meta.dirname, "../control-plane/Pulumi.prod.yaml"), "utf8");
  expect(prod).toContain("halo-control-plane:stagingTestersSecretId: halo-west-sign-in-allowlist");
  expect(prod).toContain("halo-control-plane:signInAllowlistSecretId: halo-prod-sign-in-allowlist");
});
