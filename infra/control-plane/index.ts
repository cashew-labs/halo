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
const workspaceImage = configuration.require("workspaceImage");
const googleClientIdSecretId = `${name}-control-plane-google-client-id`;
const googleClientSecretId = `${name}-control-plane-google-client-secret`;
const googleWebClientIdSecretId = `${name}-workspace-google-web-client-id`;
const googleWebClientSecretId = `${name}-workspace-google-web-client-secret`;
const controlPlaneDomain = "gethalo.dev";
const controlPlaneWwwDomain = `www.${controlPlaneDomain}`;
const controlPlaneOrigin = `https://${controlPlaneDomain}`;

const vertexAi = new gcp.projects.Service("vertex-ai", {
  project,
  service: "aiplatform.googleapis.com",
  disableOnDestroy: false,
});

const certificateManager = new gcp.projects.Service("certificate-manager", {
  project,
  service: "certificatemanager.googleapis.com",
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

const runtime = new gcp.serviceaccount.Account("control-plane-runtime", {
  accountId: `${name}-control-plane`,
  displayName: `Halo control plane ${pulumi.getStack()}`,
});
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
const workspaceImageAccess = new gcp.artifactregistry.RepositoryIamMember(
  "workspace-image-reader",
  {
    project,
    location: region,
    repository: repository.name,
    role: "roles/artifactregistry.reader",
    member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
  },
);
const workspaceLogAccess = new gcp.projects.IAMMember("workspace-logs", {
  project,
  role: "roles/logging.logWriter",
  member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
});
const workspaceInferenceAccess = new gcp.projects.IAMMember(
  "workspace-inference",
  {
    project,
    role: "roles/aiplatform.user",
    member: pulumi.interpolate`serviceAccount:${workspaceRuntime.email}`,
  },
  { dependsOn: [vertexAi] },
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
    },
    metadataStartupScript: workspaceStartup({
      gateway: true,
      googleWebOAuth: {
        clientIdSecretId: googleWebClientIdSecretId,
        clientSecretSecretId: googleWebClientSecretId,
      },
      image: workspaceImage,
      registry: `${region}-docker.pkg.dev`,
    }),
  },
  {
    dependsOn: [
      workspaceImageAccess,
      workspaceInferenceAccess,
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
      maxInstanceRequestConcurrency: 80,
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
            cpuIdle: true,
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
          volumeMounts: [{ name: "cloudsql", mountPath: "/cloudsql" }],
          envs: [
            { name: "BETTER_AUTH_URL", value: controlPlaneOrigin },
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
      databaseUrlAccess,
      googleClientIdAccess,
      googleClientSecretAccess,
      workspaceServiceAccountAccess,
    ],
  },
);

const controlPlaneAddress = new gcp.compute.GlobalAddress(
  "control-plane-address",
  {
    project,
    name: `${name}-control-plane`,
  },
  { protect: true },
);
const controlPlaneEndpoint = new gcp.compute.RegionNetworkEndpointGroup(
  "control-plane-endpoint",
  {
    project,
    region,
    name: `${name}-control-plane`,
    networkEndpointType: "SERVERLESS",
    cloudRun: { service: controlPlane.name },
  },
);
const controlPlaneBackend = new gcp.compute.BackendService(
  "control-plane-backend",
  {
    project,
    name: `${name}-control-plane`,
    loadBalancingScheme: "EXTERNAL_MANAGED",
    protocol: "HTTP",
    backends: [{ group: controlPlaneEndpoint.id }],
  },
);
const controlPlaneCertificate = new gcp.certificatemanager.Certificate(
  "control-plane-certificate",
  {
    project,
    name: `${name}-control-plane`,
    scope: "DEFAULT",
    managed: {
      domains: [controlPlaneDomain, controlPlaneWwwDomain],
    },
  },
  { dependsOn: [certificateManager] },
);
const controlPlaneCertificateMap = new gcp.certificatemanager.CertificateMap(
  "control-plane-certificate-map",
  {
    project,
    name: `${name}-control-plane`,
  },
  { dependsOn: [certificateManager] },
);
new gcp.certificatemanager.CertificateMapEntry(
  "control-plane-certificate-apex",
  {
    project,
    name: `${name}-control-plane-apex`,
    map: controlPlaneCertificateMap.name,
    hostname: controlPlaneDomain,
    certificates: [controlPlaneCertificate.id],
  },
);
new gcp.certificatemanager.CertificateMapEntry(
  "control-plane-certificate-www",
  {
    project,
    name: `${name}-control-plane-www`,
    map: controlPlaneCertificateMap.name,
    hostname: controlPlaneWwwDomain,
    certificates: [controlPlaneCertificate.id],
  },
);
const controlPlaneHttpsRoutes = new gcp.compute.URLMap(
  "control-plane-https-routes",
  {
    project,
    name: `${name}-control-plane-https`,
    defaultService: controlPlaneBackend.id,
    hostRules: [
      { hosts: [controlPlaneWwwDomain], pathMatcher: "redirect-www" },
    ],
    pathMatchers: [
      {
        name: "redirect-www",
        defaultUrlRedirect: {
          hostRedirect: controlPlaneDomain,
          httpsRedirect: true,
          redirectResponseCode: "MOVED_PERMANENTLY_DEFAULT",
          stripQuery: false,
        },
      },
    ],
  },
);
const controlPlaneHttpsProxy = new gcp.compute.TargetHttpsProxy(
  "control-plane-https-proxy",
  {
    project,
    name: `${name}-control-plane`,
    urlMap: controlPlaneHttpsRoutes.id,
    certificateMap: pulumi.interpolate`//certificatemanager.googleapis.com/${controlPlaneCertificateMap.id}`,
  },
);
new gcp.compute.GlobalForwardingRule("control-plane-https", {
  project,
  name: `${name}-control-plane-https`,
  loadBalancingScheme: "EXTERNAL_MANAGED",
  ipAddress: controlPlaneAddress.address,
  portRange: "443",
  target: controlPlaneHttpsProxy.id,
});

const controlPlaneHttpRoutes = new gcp.compute.URLMap(
  "control-plane-http-routes",
  {
    project,
    name: `${name}-control-plane-http`,
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
    project,
    name: `${name}-control-plane`,
    urlMap: controlPlaneHttpRoutes.id,
  },
);
new gcp.compute.GlobalForwardingRule("control-plane-http", {
  project,
  name: `${name}-control-plane-http`,
  loadBalancingScheme: "EXTERNAL_MANAGED",
  ipAddress: controlPlaneAddress.address,
  portRange: "80",
  target: controlPlaneHttpProxy.id,
});

export const networkId = network.id;
export const subnetId = subnet.id;
export const repositoryId = repository.name;
export const imageRepository = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${repository.repositoryId}/workspace-server`;
export const controlPlaneImageRepository = pulumi.interpolate`${region}-docker.pkg.dev/${project}/${repository.repositoryId}/control-plane`;
export const buildSourceBucket = sources.name;
export const buildServiceAccount = builder.name;
export const controlPlaneServiceAccount = runtime.email;
export const workspaceServiceAccount = workspaceRuntime.email;
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
