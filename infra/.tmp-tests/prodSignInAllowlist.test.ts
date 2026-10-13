import fs from "node:fs";
import path from "node:path";
import * as pulumi from "@pulumi/pulumi";
import { expect, test, vi } from "vitest";

type Created = { type: string; name: string; inputs: Record<string, unknown> };
let created: Created[] = [];

// Reads the plain `key: value` settings from a checked-in stack file.
function stackConfig(stack: string) {
  const file = fs.readFileSync(
    path.join(import.meta.dirname, `../control-plane/Pulumi.${stack}.yaml`),
    "utf8",
  );
  const config: Record<string, string> = {};
  for (const match of file.matchAll(/^ {2}([\w:-]+): "?([^"\n]*)"?$/gmu))
    config[match[1]!] = match[2]!;
  return config;
}

async function runStack(stack: string) {
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
  pulumi.runtime.setAllConfig(stackConfig(stack));
  const outputs = await import("../control-plane/index.js");
  await new Promise((resolve) =>
    pulumi.output(outputs.controlPlaneName).apply(resolve),
  );
}

function controlPlaneEnv(name: string) {
  const service = created.find(
    (resource) => resource.type === "gcp:cloudrunv2/service:Service",
  );
  // SAFETY: the mock records the Cloud Run inputs as plain JSON.
  const template = service?.inputs.template as {
    containers: { envs: { name: string; value: unknown }[] }[];
  };
  return template.containers[0]?.envs.find((env) => env.name === name)?.value;
}

test.each([
  ["prod", "halo-prod-sign-in-allowlist"],
  ["west", "halo-west-sign-in-allowlist"],
])(
  "the %s stack limits sign-in to %s",
  async (stack, secretId) => {
    await runStack(stack);
    const access = created.find(
      (resource) => resource.name === "sign-in-allowlist-access",
    );
    expect(access?.inputs.secretId).toBe(secretId);
    expect(access?.inputs.role).toBe("roles/secretmanager.secretAccessor");
    expect(controlPlaneEnv("SIGN_IN_ALLOWLIST_SECRET_ID")).toBe(secretId);
  },
  30_000,
);
