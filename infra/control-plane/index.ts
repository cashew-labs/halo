/* oxlint-disable anti-slop/no-unused-exports, eslint/no-new -- Pulumi registers resources and stack outputs through module side effects. */
import * as gcp from "@pulumi/gcp";
import * as pulumi from "@pulumi/pulumi";
import * as random from "@pulumi/random";
import { workspaceStartup } from "../workspace/startup.js";

const configuration = new pulumi.Config();
const cloud = new pulumi.Config("gcp");
const project = cloud.require("project");
const region = cloud.require("region");
const zone = cloud.require("zone");
const name = `halo-${pulumi.getStack()}`;
const databaseName = "halo";
const databaseUserName = "halo";
const controlPlaneServiceName = `${name}-control-plane`;
const controlPlaneImage = configuration.require("controlPlaneImage");
const workspaceProvider = configuration.get("workspaceProvider") ?? "gcp";
if (workspaceProvider !== "gcp" && workspaceProvider !== "exe")
  throw new Error("workspaceProvider must be gcp or exe");
const exeTemplateVmName =
  workspaceProvider === "exe"
    ? configuration.require("exeTemplateVmName")
    : undefined;
const exePrivateKeySecretId =
  workspaceProvider === "exe"
    ? configuration.require("exePrivateKeySecretId")
    : undefined;
// Staging keeps its existing seed; a new stack generates its own.
const exeGatewaySecretId =
  workspaceProvider === "exe"
    ? (configuration.get("exeGatewaySecretId") ?? createExeGatewaySecret())
    : undefined;

const workspaceImage = configuration.require("workspaceImage");
const deploymentServiceAccount = configuration.require(
  "deploymentServiceAccount",
);
// Stacks may share one Google sign-in client by naming another stack's secrets.
const googleClientIdSecretId =
  configuration.get("googleClientIdSecretId") ??
  `${name}-control-plane-google-client-id`;
const googleClientSecretId =
  configuration.get("googleClientSecretId") ??
  `${name}-control-plane-google-client-secret`;
// Project-wide grants to the shared deployment identity need exactly one owning
// stack: deleting or replacing a non-authoritative binding in either stack
// would remove it for both.
const ownsDeploymentAccess =
  configuration.getBoolean("ownsDeploymentAccess") ?? true;
const googleWebClientIdSecretId = "halo-workspace-google-web-client-id";
const googleWebClientSecretId = "halo-workspace-google-web-client-secret";
const togetherApiKeySecretId = "together-ai-api-key";
// Shared by every stack; packages/config/src/controlPlane.ts reads this ID.
const integrationCredentialKeySecretId =
  "halo-control-plane-integration-credential-key";
const controlPlaneDomain = configuration.require("controlPlaneDomain");
// Limits sign-in to the emails in this secret; its value is set
// outside Pulumi so the list never appears in code. Unset allows anyone.
const signInAllowlistSecretId = configuration.get("signInAllowlistSecretId");
// Production offers the desktop staging toggle to the emails in this secret,
// usually the staging allowlist. It never limits production sign-in.
const stagingTestersSecretId = configuration.get("stagingTestersSecretId");
// coverage-exempt: Pulumi deployment configuration is checked by typecheck and infrastructure review; unit tests do not provision Cloud Run.
const googleAnalyticsMeasurementId = configuration.get(
  "googleAnalyticsMeasurementId",
);
// Staging serves the web app's staging/ overrides, such as its yellow logo.
const environment = configuration.get("environment");

const controlPlaneOrigin = `https://${controlPlaneDomain}`;
// Apex domains also serve www and redirect it; subdomains such as staging do not.
const redirectWww = configuration.getBoolean("redirectWww") ?? true;
const controlPlaneHostnames = redirectWww
  ? [controlPlaneDomain, `www.${controlPlaneDomain}`]
  : [controlPlaneDomain];
// A stack that deploys another stack's release images reads that stack's
// repository instead of owning a repository, build bucket, and builder.
const sharedImageRepositoryId = configuration.get("imageRepositoryId");

// URLs can contain private webhook tokens. Cloud Run request logs are generated
// before application redaction, so exclude this route at the logging sink.
// Keep this filter on any additional or inherited export sinks (see README).
const deploymentLoggingConfig = ownsDeploymentAccess
  ? [
      new gcp.projects.IAMMember("deployment-logging-config", {
        project,
        role: "roles/logging.configWriter",
        member: `serviceAccount:${deploymentServiceAccount}`,
      }),
    ]
  : [];
new gcp.logging.ProjectExclusion(
  "webhook-request-secrets",
  {
    project,
    name: `${name}-webhook-request-secrets`,
    description: "Do not retain webhook URLs containing bearer credentials",
    filter: 'httpRequest.requestUrl =~ "/api/webhooks/"',
  },
  { dependsOn: deploymentLoggingConfig },
);

const pubsubApi = new gcp.projects.Service("gmail-pubsub-api", {
  project,
  service: "pubsub.googleapis.com",
  disableOnDestroy: false,
});
const gmailApi = new gcp.projects.Service("gmail-api", {
  project,
  service: "gmail.googleapis.com",
  disableOnDestroy: false,
});
const deploymentPubsubAdmin = ownsDeploymentAccess
  ? [
      new gcp.projects.IAMMember("deployment-pubsub-admin", {
        project,
        role: "roles/pubsub.admin",
        member: `serviceAccount:${deploymentServiceAccount}`,
      }),
    ]
  : [];
const gmailTopic = new gcp.pubsub.Topic(
  "gmail-events",
  { project, name: `${name}-gmail-events` },
  { dependsOn: [pubsubApi, gmailApi, ...deploymentPubsubAdmin] },
);
new gcp.pubsub.TopicIAMMember("gmail-publisher", {
  project,
  topic: gmailTopic.name,
  role: "roles/pubsub.publisher",
  member: "serviceAccount:gmail-api-push@system.gserviceaccount.com",
});
const gmailPushIdentity = new gcp.serviceaccount.Account(
  "gmail-push-identity",
  {
    project,
    accountId: `${name}-gmail-push`,
    displayName: "Authenticated Gmail Pub/Sub delivery",
  },
);
const pubsubIdentity = new gcp.projects.ServiceIdentity(
  "gmail-pubsub-service-identity",
  { project, service: "pubsub.googleapis.com" },
  { dependsOn: pubsubApi },
);
const pubsubTokenCreator = new gcp.serviceaccount.IAMMember(
  "gmail-push-token-creator",
  {
    serviceAccountId: gmailPushIdentity.name,
    role: "roles/iam.serviceAccountTokenCreator",
    member: pulumi.interpolate`serviceAccount:${pubsubIdentity.email}`,
  },
  { dependsOn: pubsubApi },
);
const gmailPushDeployer = new gcp.serviceaccount.IAMMember(
  "gmail-push-deployer",
  {
    serviceAccountId: gmailPushIdentity.name,
    role: "roles/iam.serviceAccountUser",
    member: `serviceAccount:${deploymentServiceAccount}`,
  },
);
new gcp.pubsub.Subscription(
  "gmail-events-push",
  {
    project,
    name: `${name}-gmail-events-push`,
    topic: gmailTopic.id,
    ackDeadlineSeconds: 30,
    messageRetentionDuration: "604800s",
    expirationPolicy: { ttl: "" },
    retryPolicy: { minimumBackoff: "10s", maximumBackoff: "600s" },
    pushConfig: {
      pushEndpoint: `${controlPlaneOrigin}/api/automation-events/gmail`,
      oidcToken: {
        serviceAccountEmail: gmailPushIdentity.email,
        audience: `${controlPlaneOrigin}/api/automation-events/gmail`,
      },
    },
  },
  { dependsOn: [pubsubTokenCreator, gmailPushDeployer] },
);

const vertexAi = new gcp.projects.Service("vertex-ai", {
  project,
  service: "aiplatform.googleapis.com",
  disableOnDestroy: false,
});

const network = new gcp.compute.Network("network", {
  name,
  autoCreateSubnetworks: false,
});
const subnet = new gcp.compute.Subnetwork("subnet", {
  name,
  network: network.id,
  region,
  ipCidrRange: "10.42.0.0/20",
  privateIpGoogleAccess: true,
});
// Exe workspaces do not use this VPC; Cloud Run sends only private traffic into it.
if (workspaceProvider === "gcp") {
  const router = new gcp.compute.Router("router", {
    name: `${name}-router`,
    network: network.id,
    region,
  });
  new gcp.compute.RouterNat("nat", {
    name: `${name}-nat`,
    router: router.name,
    region,
    natIpAllocateOption: "AUTO_ONLY",
    sourceSubnetworkIpRangesToNat: "LIST_OF_SUBNETWORKS",
    subnetworks: [{ name: subnet.id, sourceIpRangesToNats: ["ALL_IP_RANGES"] }],
    logConfig: { enable: true, filter: "ERRORS_ONLY" },
  });
}
new gcp.compute.Firewall("ssh", {
  name: `${name}-iap-ssh`,
  network: network.id,
  // Google IAP's TCP forwarding range; workspace HTTP ports stay private.
  sourceRanges: ["35.235.240.0/20"],
  targetTags: ["halo-workspace"],
  allows: [{ protocol: "tcp", ports: ["22"] }],
});
new gcp.compute.Firewall("workspace-gateway", {
  name: `${name}-workspace-gateway`,
  network: network.id,
  sourceTags: ["halo-control-plane"],
  targetTags: ["halo-workspace"],
  allows: [{ protocol: "tcp", ports: ["8788"] }],
});

const imageBuild =
  sharedImageRepositoryId === undefined
    ? createImageBuild()
    : {
        repositoryId: sharedImageRepositoryId,
        sources: undefined,
        builder: undefined,
        imagePuller: undefined,
      };
const imageRepositoryId = imageBuild.repositoryId;

function createImageBuild() {
  const repository = new gcp.artifactregistry.Repository("images", {
    repositoryId: `${name}-workspaces`,
    location: region,
    format: "DOCKER",
  });
  const sources = new gcp.storage.Bucket("build-sources", {
    name: `${project}-${name}-build-sources`,
    location: region,
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
    lifecycleRules: [{ action: { type: "Delete" }, condition: { age: 7 } }],
  });
  const builder = new gcp.serviceaccount.Account("builder", {
    accountId: `${name}-builder`,
    displayName: "Halo workspace image builder",
  });
  new gcp.artifactregistry.RepositoryIamMember("image-writer", {
    project,
    location: region,
    repository: repository.name,
    role: "roles/artifactregistry.writer",
    member: pulumi.interpolate`serviceAccount:${builder.email}`,
  });
  new gcp.storage.BucketIAMMember("source-reader", {
    bucket: sources.name,
    role: "roles/storage.objectViewer",
    member: pulumi.interpolate`serviceAccount:${builder.email}`,
  });
  new gcp.projects.IAMMember("build-logs", {
    project,
    role: "roles/logging.logWriter",
    member: pulumi.interpolate`serviceAccount:${builder.email}`,
  });
  // exe.dev workspaces pull release images with a short-lived token minted for
  // this account by the release runner (infra/workspace/exeRollout.sh). It can
  // only read this repository, so a token leaked from a guest grants nothing else.
  const imagePuller = new gcp.serviceaccount.Account("image-puller", {
    accountId: `${name}-image-puller`,
    displayName: "Halo workspace image puller",
  });
  new gcp.artifactregistry.RepositoryIamMember("image-puller-reader", {
    project,
    location: region,
    repository: repository.repositoryId,
    role: "roles/artifactregistry.reader",
    member: pulumi.interpolate`serviceAccount:${imagePuller.email}`,
  });
  new gcp.serviceaccount.IAMMember("deployment-image-puller-token", {
    serviceAccountId: imagePuller.name,
    role: "roles/iam.serviceAccountTokenCreator",
    member: `serviceAccount:${deploymentServiceAccount}`,
  });
  return {
    repositoryId: repository.repositoryId,
    sources,
    builder,
    imagePuller,
  };
}

const runtime = new gcp.serviceaccount.Account("control-plane-runtime", {
  accountId: `${name}-control-plane`,
  displayName: `Halo control plane ${pulumi.getStack()}`,
});
// coverage-exempt: Declarative Pulumi IAM resources require cloud credentials and are validated by infra typecheck; no cloud mutation occurs in tests.
const deploymentRoleAdmin = ownsDeploymentAccess
  ? [
      new gcp.projects.IAMMember("deployment-role-admin", {
        project,
        role: "roles/iam.roleAdmin",
        member: `serviceAccount:${deploymentServiceAccount}`,
      }),
    ]
  : [];
// coverage-exempt: Declarative Pulumi IAM resources require cloud credentials and are validated by infra typecheck; no cloud mutation occurs in tests.
const modelCaller = new gcp.projects.IAMCustomRole(
  "model-caller",
  {
    project,
    // Stacks share the project, and role IDs allow only letters, digits, `_`, and `.`.
    roleId: `${name.replaceAll("-", "_")}_model_caller`,
    title: `Halo ${pulumi.getStack()} model caller`,
    description: "Call Vertex AI models without managing Vertex AI resources.",
    permissions: ["aiplatform.endpoints.predict"],
  },
  { dependsOn: deploymentRoleAdmin },
);
// coverage-exempt: Declarative Pulumi IAM resources require cloud credentials and are validated by infra typecheck; no cloud mutation occurs in tests.
const controlPlaneInferenceAccess = new gcp.projects.IAMMember(
  "control-plane-inference",
  {
    project,
    role: modelCaller.name,
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
  { dependsOn: [vertexAi] },
);
new gcp.projects.IAMMember("control-plane-logs", {
  project,
  role: "roles/logging.logWriter",
  member: pulumi.interpolate`serviceAccount:${runtime.email}`,
});
new gcp.projects.IAMMember("control-plane-cloud-sql", {
  project,
  role: "roles/cloudsql.client",
  member: pulumi.interpolate`serviceAccount:${runtime.email}`,
});

const workspaceRuntime = new gcp.serviceaccount.Account("workspace-runtime", {
  accountId: `${name}-workspace`,
  displayName: `Halo workspace runtime ${pulumi.getStack()}`,
});
const traces = new gcp.storage.Bucket(
  "agent-traces",
  {
    name: `${project}-${name}-traces`,
    project,
    location: region,
    storageClass: "STANDARD",
    uniformBucketLevelAccess: true,
    publicAccessPrevention: "enforced",
    forceDestroy: false,
    // Traces have no expiration; soft delete only controls recovery after deletion.
    softDeletePolicy: { retentionDurationSeconds: 30 * 24 * 60 * 60 },
  },
  { protect: true },
);
const controlPlaneTraceAccess = new gcp.storage.BucketIAMMember(
  "control-plane-trace-writer",
  {
    bucket: traces.name,
    role: "roles/storage.objectCreator",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);
const workspaceImageAccess = new gcp.artifactregistry.RepositoryIamMember(
  "workspace-image-reader",
  {
    project,
    location: region,
    repository: imageRepositoryId,
    role: "roles/artifactregistry.reader",
    member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
  },
);
const workspaceLogAccess = new gcp.projects.IAMMember("workspace-logs", {
  project,
  role: "roles/logging.logWriter",
  member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
});
// IAM is deployed before VMs are replaced; keep Vertex access until all run Together.
const workspaceInferenceAccess = new gcp.projects.IAMMember(
  "workspace-inference",
  {
    project,
    role: "roles/aiplatform.user",
    member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
  },
  { dependsOn: [vertexAi] },
);
const workspaceTogetherApiKeyAccess = new gcp.secretmanager.SecretIamMember(
  "workspace-together-api-key",
  {
    project,
    secretId: togetherApiKeySecretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
  },
);
const workspaceGoogleWebClientIdAccess = new gcp.secretmanager.SecretIamMember(
  "workspace-google-web-client-id",
  {
    project,
    secretId: googleWebClientIdSecretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
  },
);
const workspaceGoogleWebClientSecretAccess =
  new gcp.secretmanager.SecretIamMember("workspace-google-web-client-secret", {
    project,
    secretId: googleWebClientSecretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
  });

const controlPlaneComputeAccess = new gcp.projects.IAMMember(
  "control-plane-compute",
  {
    project,
    role: "roles/compute.instanceAdmin.v1",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);
const workspaceServiceAccountAccess = new gcp.serviceaccount.IAMMember(
  "control-plane-workspace-service-account",
  {
    serviceAccountId: workspaceRuntime.name,
    role: "roles/iam.serviceAccountUser",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);

if (ownsDeploymentAccess) {
  new gcp.projects.IAMMember("deployment-workspace-os-login", {
    project,
    role: "roles/compute.osAdminLogin",
    member: `serviceAccount:${deploymentServiceAccount}`,
  });
  new gcp.projects.IAMMember("deployment-workspace-iap", {
    project,
    role: "roles/iap.tunnelResourceAccessor",
    member: `serviceAccount:${deploymentServiceAccount}`,
    condition: {
      title: "workspace-ssh",
      expression: "destination.port == 22",
    },
  });
}
new gcp.serviceaccount.IAMMember("deployment-workspace-service-account", {
  serviceAccountId: workspaceRuntime.name,
  role: "roles/iam.serviceAccountUser",
  member: `serviceAccount:${deploymentServiceAccount}`,
});

const workspaceTemplate = new gcp.compute.InstanceTemplate(
  "workspace-template",
  {
    project,
    region,
    namePrefix: `${name}-workspace-`,
    instanceDescription: "Halo workspace server",
    machineType: "e2-standard-2",
    // The control plane adds each user's durable halo-workspace disk when it creates the VM.
    disks: [
      {
        sourceImage: "debian-cloud/debian-12",
        diskSizeGb: 20,
        diskType: "pd-balanced",
        autoDelete: true,
        boot: true,
      },
    ],
    networkInterfaces: [{ network: network.id, subnetwork: subnet.id }],
    tags: ["halo-workspace"],
    serviceAccount: {
      email: workspaceRuntime.email,
      scopes: ["cloud-platform"],
    },
    metadata: {
      "enable-oslogin": "TRUE",
      "block-project-ssh-keys": "TRUE",
      "halo-control-plane-service-account": runtime.email,
      "halo-control-plane-origin": controlPlaneOrigin,
    },
    metadataStartupScript: workspaceStartup({
      gateway: true,
      image: workspaceImage,
      registry: `${region}-docker.pkg.dev`,
    }),
  },
  {
    dependsOn: [
      workspaceImageAccess,
      workspaceInferenceAccess,
      workspaceTogetherApiKeyAccess,
      workspaceLogAccess,
      workspaceGoogleWebClientIdAccess,
      workspaceGoogleWebClientSecretAccess,
    ],
  },
);

const databasePassword = new random.RandomPassword("database-password", {
  length: 48,
  special: false,
});
const authSecretValue = new random.RandomPassword("auth-secret-value", {
  length: 48,
  special: false,
});
const databaseInstance = new gcp.sql.DatabaseInstance(
  "control-plane-database",
  {
    name: `${name}-control-plane-db`,
    project,
    region,
    databaseVersion: "POSTGRES_16",
    deletionProtection: true,
    settings: {
      tier: "db-f1-micro",
      edition: "ENTERPRISE",
      availabilityType: "ZONAL",
      activationPolicy: "ALWAYS",
      connectorEnforcement: "REQUIRED",
      diskType: "PD_SSD",
      diskSize: 10,
      diskAutoresize: true,
      deletionProtectionEnabled: true,
      backupConfiguration: {
        enabled: true,
        pointInTimeRecoveryEnabled: true,
        startTime: "09:00",
        transactionLogRetentionDays: 7,
        backupRetentionSettings: {
          retainedBackups: 7,
          retentionUnit: "COUNT",
        },
      },
      ipConfiguration: { ipv4Enabled: true },
    },
  },
  { protect: true, ignoreChanges: ["settings.diskSize"] },
);
const appDatabase = new gcp.sql.Database("control-plane-app-database", {
  project,
  instance: databaseInstance.name,
  name: databaseName,
});
const appDatabaseUser = new gcp.sql.User("control-plane-app-user", {
  project,
  instance: databaseInstance.name,
  name: databaseUserName,
  password: databasePassword.result,
});

const databaseUrlSecret = new gcp.secretmanager.Secret(
  "database-url-secret",
  {
    project,
    secretId: `${name}-control-plane-database-url`,
    replication: { auto: {} },
    deletionProtection: true,
  },
  { protect: true },
);
const databaseUrl = pulumi.interpolate`postgresql://${databaseUserName}:${databasePassword.result}@/${databaseName}?host=/cloudsql/${databaseInstance.connectionName}`;
const databaseUrlVersion = new gcp.secretmanager.SecretVersion(
  "database-url-version",
  {
    secret: databaseUrlSecret.id,
    secretData: databaseUrl,
  },
  { protect: true, dependsOn: [appDatabase, appDatabaseUser] },
);
const databaseUrlAccess = new gcp.secretmanager.SecretIamMember(
  "database-url-access",
  {
    project,
    secretId: databaseUrlSecret.id,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);

const authSecret = new gcp.secretmanager.Secret(
  "auth-secret",
  {
    project,
    secretId: `${name}-control-plane-auth`,
    replication: { auto: {} },
    deletionProtection: true,
  },
  { protect: true },
);
const authSecretVersion = new gcp.secretmanager.SecretVersion(
  "auth-secret-version",
  {
    secret: authSecret.id,
    secretData: authSecretValue.result,
  },
  { protect: true },
);
const authSecretAccess = new gcp.secretmanager.SecretIamMember(
  "auth-secret-access",
  {
    project,
    secretId: authSecret.id,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);

const googleClientIdAccess = new gcp.secretmanager.SecretIamMember(
  "google-client-id-access",
  {
    project,
    secretId: googleClientIdSecretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);

const googleClientSecretAccess = new gcp.secretmanager.SecretIamMember(
  "google-client-secret-access",
  {
    project,
    secretId: googleClientSecretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);

const controlPlaneTogetherApiKeyAccess = new gcp.secretmanager.SecretIamMember(
  "control-plane-together-api-key",
  {
    project,
    secretId: togetherApiKeySecretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);

const controlPlaneIntegrationKeyAccess = new gcp.secretmanager.SecretIamMember(
  "control-plane-integration-credential-key",
  {
    project,
    secretId: integrationCredentialKeySecretId,
    role: "roles/secretmanager.secretAccessor",
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);

const signInAllowlistAccess =
  signInAllowlistSecretId === undefined
    ? []
    : [
        new gcp.secretmanager.SecretIamMember("sign-in-allowlist-access", {
          project,
          secretId: signInAllowlistSecretId,
          role: "roles/secretmanager.secretAccessor",
          member: pulumi.interpolate`serviceAccount:${runtime.email}`,
        }),
      ];

const stagingTestersAccess =
  stagingTestersSecretId === undefined
    ? []
    : [
        new gcp.secretmanager.SecretIamMember("staging-testers-access", {
          project,
          secretId: stagingTestersSecretId,
          role: "roles/secretmanager.secretAccessor",
          member: pulumi.interpolate`serviceAccount:${runtime.email}`,
        }),
      ];

const exeSecretAccess = [exePrivateKeySecretId, exeGatewaySecretId].flatMap(
  (secretId, index) =>
    secretId === undefined
      ? []
      : [
          new gcp.secretmanager.SecretIamMember(`exe-secret-access-${index}`, {
            project,
            secretId,
            role: "roles/secretmanager.secretAccessor",
            member: pulumi.interpolate`serviceAccount:${runtime.email}`,
          }),
        ],
);

if (ownsDeploymentAccess && exePrivateKeySecretId !== undefined)
  new gcp.secretmanager.SecretIamMember("exe-release-key-access", {
    project,
    secretId: exePrivateKeySecretId,
    role: "roles/secretmanager.secretAccessor",
    member: `serviceAccount:${deploymentServiceAccount}`,
  });

// coverage-exempt: Pulumi resource declarations require an authenticated cloud preview; types and provider behavior are tested locally.
const certificateManager = new gcp.projects.Service("certificate-manager", {
  project,
  service: "certificatemanager.googleapis.com",
  disableOnDestroy: false,
});
// coverage-exempt: Pulumi resource declarations require an authenticated cloud preview; types and provider behavior are tested locally.
const controlPlaneAddress = new gcp.compute.GlobalAddress(
  "control-plane-address",
  { name: controlPlaneServiceName, project },
  { protect: true },
);
// coverage-exempt: Pulumi resource declarations require an authenticated cloud preview; types and provider behavior are tested locally.
const controlPlaneCertificateMap = new gcp.certificatemanager.CertificateMap(
  "control-plane-certificate-map",
  { name: controlPlaneServiceName, project },
  { dependsOn: [certificateManager] },
);

// coverage-exempt: Pulumi resource declarations require an authenticated cloud preview; types and provider behavior are tested locally.
const appDomainCertificateRole = new gcp.projects.IAMCustomRole(
  "app-domain-certificates",
  {
    project,
    roleId: `${name.replaceAll("-", "_")}_app_domains`,
    title: "Halo custom domain certificates",
    permissions: [
      "certificatemanager.dnsauthorizations.create",
      "certificatemanager.dnsauthorizations.get",
      "certificatemanager.dnsauthorizations.use",
      "certificatemanager.dnsauthorizations.delete",
      "certificatemanager.certs.create",
      "certificatemanager.certs.get",
      "certificatemanager.certs.use",
      "certificatemanager.certs.delete",
      "certificatemanager.certmapentries.create",
      "certificatemanager.certmapentries.get",
      "certificatemanager.certmaps.get",
      "certificatemanager.certmaps.use",
      "certificatemanager.certmapentries.delete",
      "certificatemanager.operations.get",
    ],
  },
  { dependsOn: [certificateManager, ...deploymentRoleAdmin] },
);
// coverage-exempt: Runtime IAM binding is applied by Pulumi, not executed by unit tests.
const appDomainCertificateAccess = new gcp.projects.IAMMember(
  "runtime-app-domain-certificates",
  {
    project,
    role: appDomainCertificateRole.name,
    member: pulumi.interpolate`serviceAccount:${runtime.email}`,
  },
);
const controlPlane = new gcp.cloudrunv2.Service(
  "control-plane-service",
  {
    project,
    location: region,
    name: controlPlaneServiceName,
    description: "Halo control plane",
    deletionProtection: true,
    ingress: "INGRESS_TRAFFIC_ALL",
    invokerIamDisabled: true,
    template: {
      executionEnvironment: "EXECUTION_ENVIRONMENT_GEN2",
      serviceAccount: runtime.email,
      timeout: "3600s",
      maxInstanceRequestConcurrency: 500,
      scaling: { minInstanceCount: 1, maxInstanceCount: 1 },
      vpcAccess: {
        egress: "PRIVATE_RANGES_ONLY",
        networkInterfaces: [
          {
            network: network.name,
            subnetwork: subnet.name,
            tags: ["halo-control-plane"],
          },
        ],
      },
      volumes: [
        ...(exePrivateKeySecretId === undefined
          ? []
          : [
              {
                name: "exe-account-key",
                secret: {
                  secret: exePrivateKeySecretId,
                  items: [{ version: "1", path: "key", mode: 0o444 }],
                },
              },
            ]),
        {
          name: "cloudsql",
          cloudSqlInstance: { instances: [databaseInstance.connectionName] },
        },
      ],
      containers: [
        {
          name: "control-plane",
          image: controlPlaneImage,
          ports: { name: "http1", containerPort: 8080 },
          resources: {
            limits: { cpu: "1", memory: "512Mi" },
            cpuIdle: false,
            startupCpuBoost: true,
          },
          startupProbe: {
            httpGet: { path: "/health", port: 8080 },
            periodSeconds: 2,
            timeoutSeconds: 1,
            failureThreshold: 30,
          },
          livenessProbe: {
            httpGet: { path: "/health", port: 8080 },
            initialDelaySeconds: 10,
            periodSeconds: 30,
            timeoutSeconds: 5,
            failureThreshold: 3,
          },
          volumeMounts: [
            { name: "cloudsql", mountPath: "/cloudsql" },
            ...(exePrivateKeySecretId === undefined
              ? []
              : [{ name: "exe-account-key", mountPath: "/etc/halo/exe" }]),
          ],
          envs: [
            { name: "GMAIL_PUBSUB_TOPIC", value: gmailTopic.id },
            {
              name: "GMAIL_PUSH_SERVICE_ACCOUNT",
              value: gmailPushIdentity.email,
            },
            { name: "WORKSPACE_PROVIDER", value: workspaceProvider },
            ...(workspaceProvider !== "exe"
              ? []
              : [
                  { name: "EXE_TEMPLATE_VM_NAME", value: exeTemplateVmName },
                  { name: "EXE_WORKSPACE_TAG", value: name },
                  { name: "EXE_PRIVATE_KEY_PATH", value: "/etc/halo/exe/key" },
                  { name: "EXE_GATEWAY_SECRET_ID", value: exeGatewaySecretId },
                ]),
            { name: "BETTER_AUTH_URL", value: controlPlaneOrigin },

            // coverage-exempt: Pulumi passes this public stream ID into Cloud Run; exercised after deployment rather than by provisioning cloud infrastructure in tests.
            ...(googleAnalyticsMeasurementId === undefined
              ? []
              : [
                  {
                    name: "GOOGLE_ANALYTICS_MEASUREMENT_ID",
                    value: googleAnalyticsMeasurementId,
                  },
                ]),
            ...(environment === undefined
              ? []
              : [{ name: "HALO_ENVIRONMENT", value: environment }]),

            {
              name: "DATABASE_URL_SECRET_ID",
              value: databaseUrlSecret.secretId,
            },
            {
              name: "BETTER_AUTH_SECRET_ID",
              value: authSecret.secretId,
            },
            {
              name: "GOOGLE_CLIENT_ID_SECRET_ID",
              value: googleClientIdSecretId,
            },
            {
              name: "GOOGLE_CLIENT_SECRET_ID",
              value: googleClientSecretId,
            },
            // coverage-exempt: Cloud Run environment wiring is evaluated during Pulumi preview; configuration parsing is tested separately.
            { name: "APP_DOMAIN_PROJECT_ID", value: project },
            // coverage-exempt: Cloud Run environment wiring is evaluated during Pulumi preview.
            {
              name: "APP_DOMAIN_CERTIFICATE_MAP",
              value: controlPlaneCertificateMap.name,
            },
            // coverage-exempt: Load-balancer address is a Pulumi output, not a runtime computation.
            { name: "APP_DOMAIN_ADDRESS", value: controlPlaneAddress.address },
            { name: "TRACE_BUCKET", value: traces.name },
            ...(signInAllowlistSecretId === undefined
              ? []
              : [
                  {
                    name: "SIGN_IN_ALLOWLIST_SECRET_ID",
                    value: signInAllowlistSecretId,
                  },
                ]),
            ...(stagingTestersSecretId === undefined
              ? []
              : [
                  {
                    name: "STAGING_TESTERS_SECRET_ID",
                    value: stagingTestersSecretId,
                  },
                ]),
            {
              name: "WORKSPACE_SERVICE_ACCOUNT",
              value: workspaceRuntime.email,
            },
            { name: "WORKSPACE_PROJECT_ID", value: project },
            { name: "WORKSPACE_ZONE", value: zone },
            {
              name: "WORKSPACE_INSTANCE_TEMPLATE",
              value: workspaceTemplate.name,
            },
          ],
        },
      ],
    },
  },
  {
    protect: true,
    dependsOn: [
      authSecretAccess,
      controlPlaneComputeAccess,
      controlPlaneInferenceAccess, // coverage-exempt: Declarative Pulumi deployment ordering is checked by infra typecheck, not a cloud deployment in tests.
      appDomainCertificateAccess, // coverage-exempt: Pulumi applies runtime IAM before promoting the domain-enabled revision; live cloud ordering is not a unit-test boundary.
      controlPlaneIntegrationKeyAccess,
      controlPlaneTogetherApiKeyAccess,
      ...signInAllowlistAccess,
      ...stagingTestersAccess,
      controlPlaneTraceAccess,
      databaseUrlAccess,
      googleClientIdAccess,
      googleClientSecretAccess,
      ...exeSecretAccess,
      workspaceServiceAccountAccess,
    ],
  },
);

// Changing controlPlaneDomain replaces the certificate, which the deploy
// identity must be able to delete.
const deploymentCertificateAccess = ownsDeploymentAccess
  ? [
      new gcp.projects.IAMMember("deployment-certificate-manager", {
        project,
        role: "roles/certificatemanager.editor",
        member: `serviceAccount:${deploymentServiceAccount}`,
      }),
    ]
  : [];
const controlPlaneCertificate = new gcp.certificatemanager.Certificate(
  "control-plane-certificate",
  {
    name: controlPlaneServiceName,
    project,
    scope: "DEFAULT",
    managed: { domains: controlPlaneHostnames },
  },
  { dependsOn: [certificateManager, ...deploymentCertificateAccess] },
);
new gcp.certificatemanager.CertificateMapEntry(
  "control-plane-certificate-apex",
  {
    name: `${controlPlaneServiceName}-apex`,
    project,
    map: controlPlaneCertificateMap.name,
    certificates: [controlPlaneCertificate.id],
    hostname: controlPlaneDomain,
  },
);
if (redirectWww)
  new gcp.certificatemanager.CertificateMapEntry(
    "control-plane-certificate-www",
    {
      name: `${controlPlaneServiceName}-www`,
      project,
      map: controlPlaneCertificateMap.name,
      certificates: [controlPlaneCertificate.id],
      hostname: `www.${controlPlaneDomain}`,
    },
  );
// coverage-exempt: Pulumi resource declarations; checked by typecheck and `pnpm infra:control-plane:preview`, not unit tests.
// Creator hosts (`handle.<domain>`) serve shared apps from the same service.
// A wildcard certificate needs DNS authorization; the DNS records to create are
// exported below because the domain's DNS is managed outside this stack.
const creatorDnsAuthorization = new gcp.certificatemanager.DnsAuthorization(
  "creator-dns-authorization",
  {
    name: `${controlPlaneServiceName}-creators`,
    project,
    domain: controlPlaneDomain,
  },
  { dependsOn: [certificateManager] },
);
const creatorCertificate = new gcp.certificatemanager.Certificate(
  "creator-certificate",
  {
    name: `${controlPlaneServiceName}-creators`,
    project,
    scope: "DEFAULT",
    managed: {
      domains: [`*.${controlPlaneDomain}`],
      dnsAuthorizations: [creatorDnsAuthorization.id],
    },
  },
  { dependsOn: [certificateManager, ...deploymentCertificateAccess] },
);
// Exact entries such as www take precedence over the wildcard.
new gcp.certificatemanager.CertificateMapEntry("creator-certificate-wildcard", {
  name: `${controlPlaneServiceName}-creators`,
  project,
  map: controlPlaneCertificateMap.name,
  certificates: [creatorCertificate.id],
  hostname: `*.${controlPlaneDomain}`,
});
const controlPlaneEndpoint = new gcp.compute.RegionNetworkEndpointGroup(
  "control-plane-endpoint",
  {
    name: controlPlaneServiceName,
    project,
    region,
    networkEndpointType: "SERVERLESS",
    cloudRun: { service: controlPlane.name },
  },
);
const controlPlaneBackend = new gcp.compute.BackendService(
  "control-plane-backend",
  {
    name: controlPlaneServiceName,
    project,
    loadBalancingScheme: "EXTERNAL_MANAGED",
    protocol: "HTTP",
    backends: [{ group: controlPlaneEndpoint.id }],
  },
);
const controlPlaneHttpsRoutes = new gcp.compute.URLMap(
  "control-plane-https-routes",
  {
    name: `${controlPlaneServiceName}-https`,
    project,
    defaultService: controlPlaneBackend.id,
    hostRules: redirectWww
      ? [{ hosts: [`www.${controlPlaneDomain}`], pathMatcher: "redirect-www" }]
      : [],
    pathMatchers: redirectWww
      ? [
          {
            name: "redirect-www",
            defaultUrlRedirect: {
              hostRedirect: controlPlaneDomain,
              httpsRedirect: true,
              redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
              stripQuery: false,
            },
          },
        ]
      : [],
  },
);
const controlPlaneHttpsProxy = new gcp.compute.TargetHttpsProxy(
  "control-plane-https-proxy",
  {
    name: controlPlaneServiceName,
    project,
    urlMap: controlPlaneHttpsRoutes.id,
    certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${controlPlaneCertificateMap.id}`,
  },
);
new gcp.compute.GlobalForwardingRule("control-plane-https", {
  name: `${controlPlaneServiceName}-https`,
  project,
  ipAddress: controlPlaneAddress.address,
  loadBalancingScheme: "EXTERNAL_MANAGED",
  portRange: "443",
  target: controlPlaneHttpsProxy.id,
});
const controlPlaneHttpRoutes = new gcp.compute.URLMap(
  "control-plane-http-routes",
  {
    name: `${controlPlaneServiceName}-http`,
    project,
    defaultUrlRedirect: {
      httpsRedirect: true,
      redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
      stripQuery: false,
    },
  },
);
const controlPlaneHttpProxy = new gcp.compute.TargetHttpProxy(
  "control-plane-http-proxy",
  {
    name: controlPlaneServiceName,
    project,
    urlMap: controlPlaneHttpRoutes.id,
  },
);
new gcp.compute.GlobalForwardingRule("control-plane-http", {
  name: `${controlPlaneServiceName}-http`,
  project,
  ipAddress: controlPlaneAddress.address,
  loadBalancingScheme: "EXTERNAL_MANAGED",
  portRange: "80",
  target: controlPlaneHttpProxy.id,
});

export const networkId = network.id;
export const subnetId = subnet.id;
export const repositoryId = imageRepositoryId;
export const imageRepository = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${imageRepositoryId}/workspace-server`;
export const controlPlaneImageRepository = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${imageRepositoryId}/control-plane`;
export const buildSourceBucket = imageBuild.sources?.name;
export const buildServiceAccount = imageBuild.builder?.name;
export const imagePullerServiceAccount = imageBuild.imagePuller?.email;
export const controlPlaneServiceAccount = runtime.email;
export const workspaceServiceAccount = workspaceRuntime.email;
export const traceBucket = traces.name;
// coverage-exempt: Pulumi stack output; checked by typecheck and preview.
// Create these at the DNS provider so creator hosts resolve and get TLS.
export const creatorDnsRecords = {
  hosts: {
    name: `*.${controlPlaneDomain}`,
    type: "A",
    data: controlPlaneAddress.address,
  },
  certificate: creatorDnsAuthorization.dnsResourceRecords,
};
export const workspaceInstanceTemplate = workspaceTemplate.selfLink;
export const workspaceZone = zone;
export const controlPlaneDatabaseConnectionName =
  databaseInstance.connectionName;
export const controlPlaneDatabaseUrlSecret = databaseUrlSecret.secretId;
export const controlPlaneDatabaseUrlSecretVersion = databaseUrlVersion.version;
export const controlPlaneAuthSecret = authSecret.secretId;
export const controlPlaneAuthSecretVersion = authSecretVersion.version;
export const controlPlaneName = controlPlane.name;
export const controlPlaneUrl = controlPlaneOrigin;
export const controlPlaneDomainIp = controlPlaneAddress.address;

export const selectedWorkspaceProvider = workspaceProvider;
export const exeWorkspaceTemplate = exeTemplateVmName;

function createExeGatewaySecret() {
  const secret = new gcp.secretmanager.Secret(
    "exe-gateway-seed",
    {
      project,
      secretId: `${name}-exe-gateway-seed`,
      replication: { auto: {} },
      deletionProtection: true,
    },
    { protect: true },
  );
  const version = new gcp.secretmanager.SecretVersion(
    "exe-gateway-seed-version",
    {
      secret: secret.id,
      secretData: new random.RandomPassword("exe-gateway-seed-value", {
        length: 48,
        special: false,
      }).result,
    },
    { protect: true },
  );
  // Consumers read the latest version, so they must wait for the first one.
  return pulumi
    .all([secret.secretId, version.id])
    .apply(([secretId]) => secretId);
}
