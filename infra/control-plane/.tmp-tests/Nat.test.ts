import * as pulumi from "@pulumi/pulumi";
import { expect, test, vi } from "vitest";

test.each(["gcp", "exe", undefined])(
  "only GCP workspaces provision internet NAT (%s)",
  async (provider) => {
    vi.resetModules();
    const resources: pulumi.runtime.MockResourceArgs[] = [];
    await pulumi.runtime.setMocks(
      {
        call: ({ inputs }) => inputs,
        newResource: (resource) => {
          resources.push(resource);
          return { id: resource.name, state: resource.inputs };
        },
      },
      "halo-control-plane",
      "west",
    );
    pulumi.runtime.setAllConfig({
      "gcp:project": "test-project",
      "gcp:region": "us-west2",
      "gcp:zone": "us-west2-a",
      "halo-control-plane:controlPlaneImage": "test/control-plane:latest",
      "halo-control-plane:workspaceImage": "test/workspace:latest",
      "halo-control-plane:deploymentServiceAccount":
        "deploy@test-project.iam.gserviceaccount.com",
      "halo-control-plane:controlPlaneDomain": "example.com",
      "halo-control-plane:exeTemplateVmName": "test-template",
      "halo-control-plane:exePrivateKeySecretId": "test-key",
      "halo-control-plane:exeGatewaySecretId": "test-gateway",
      ...(provider === undefined
        ? {}
        : { "halo-control-plane:workspaceProvider": provider }),
    });
    await pulumi.runtime.runInPulumiStack(
      async () => await import("../index.js"),
    );
    await pulumi.runtime.disconnect();
    const nat = resources.filter((resource) =>
      ["gcp:compute/router:Router", "gcp:compute/routerNat:RouterNat"].includes(
        resource.type,
      ),
    );
    expect(nat.map((resource) => resource.name)).toEqual(
      provider === "exe" ? [] : ["router", "nat"],
    );
    const cloudRun = resources.find(
      (resource) => resource.name === "control-plane-service",
    );
    expect(cloudRun?.inputs.template.vpcAccess.egress).toBe(
      "PRIVATE_RANGES_ONLY",
    );
    if (provider !== "exe") {
      expect(nat[1]?.inputs.subnetworks).toEqual([
        { name: "subnet", sourceIpRangesToNats: ["ALL_IP_RANGES"] },
      ]);
    }
  },
);
