/* oxlint-disable anti-slop/no-unused-exports, eslint/no-new -- Pulumi registers resources and stack outputs through module side effects. */
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import { workspaceStartup } from "./startup.js";

const configuration = new pulumi.Config();
const cloud = new pulumi.Config("gcp");
const project = cloud.require("project");
const region = cloud.require("region");
const zone = cloud.require("zone");
const name = `halo-workspace-${pulumi.getStack()}`;
const shared = new pulumi.StackReference(
  configuration.require("controlPlaneStack"),
);
const image = configuration.require("image");

const identity = new gcp.serviceaccount.Account("runtime", {
  accountId: name,
  displayName: `Halo workspace ${pulumi.getStack()}`,
});
const imageAccess = new gcp.artifactregistry.RepositoryIamMember(
  "image-reader",
  {
    project,
    location: region,
    repository: shared.requireOutput("repositoryId"),
    role: "roles/artifactregistry.reader",
    member: pulumi.interpolate`serviceAccount:${identity.email}`,
  },
);
new gcp.projects.IAMMember("runtime-logs", {
  project,
  role: "roles/logging.logWriter",
  member: pulumi.interpolate`serviceAccount:${identity.email}`,
});
const vertexAiAccess = new gcp.projects.IAMMember("vertex-ai", {
  project,
  role: "roles/aiplatform.user",
  member: pulumi.interpolate`serviceAccount:${identity.email}`,
});
const disk = new gcp.compute.Disk(
  "workspace",
  {
    name,
    zone,
    type: "pd-balanced",
    size: 50,
  },
  { protect: true },
);

const instance = new gcp.compute.Instance(
  "server",
  {
    name: `${name}-vm`,
    zone,
    machineType: "e2-standard-2",
    bootDisk: {
      initializeParams: {
        image: "debian-cloud/debian-12",
        size: 20,
        type: "pd-balanced",
      },
    },
    attachedDisks: [{ source: disk.id, deviceName: "halo-workspace" }],
    networkInterfaces: [
      {
        network: shared.requireOutput("networkId"),
        subnetwork: shared.requireOutput("subnetId"),
      },
    ],
    tags: ["halo-workspace"],
    serviceAccount: {
      email: identity.email,
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    },
    metadata: {
      "enable-oslogin": "TRUE",
      "block-project-ssh-keys": "TRUE",
      "halo-owner-user-id": "development",
    },
    metadataStartupScript: workspaceStartup({
      image,
      registry: `${region}-docker.pkg.dev`,
    }),
  },
  {
    dependsOn: [imageAccess, vertexAiAccess],
    // Replacing a VM must detach the workspace disk before its replacement attaches it.
    deleteBeforeReplace: true,
  },
);

export const instanceName = instance.name;
export const instanceZone = instance.zone;
export const diskName = disk.name;
export const serviceAccount = identity.email;
