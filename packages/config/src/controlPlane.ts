import fs from "node:fs/promises";
import path from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { ApplicationMode } from "./ApplicationMode.js";
import { readGcpSecret } from "./readGcpSecret.js";

const developmentPort = 8787;
const secretProjectId = "halo-relay";
const developmentAuthSecretIds = {
  secret: "halo-dev-local-better-auth-secret",
  googleClientId: "halo-west-control-plane-google-client-id",
  googleClientSecret: "halo-west-control-plane-google-client-secret",
};

const authSchema = Type.Object({
  secret: Type.String({ minLength: 32 }),
  googleClientId: Type.String({ minLength: 1 }),
  googleClientSecret: Type.String({ minLength: 1 }),
  // Secret Manager secret listing the emails that may sign in; unset allows all.
  signInAllowlistSecretId: Type.Optional(Type.String({ minLength: 1 })),
  // Secret Manager secret listing the emails offered the desktop staging toggle.
  stagingTestersSecretId: Type.Optional(Type.String({ minLength: 1 })),
});
const githubSchema = Type.Object({
  clientId: Type.String({ minLength: 1 }),
  clientSecret: Type.String({ minLength: 1 }),
});
// Non-production environments serve the web app's same-named override
// folder, such as development/ or staging/ logos. Absent means production.
const environmentSchema = Type.Union([
  Type.Literal("production"),
  Type.Literal("staging"),
  Type.Literal("development"),
]);
const portSchema = Type.Integer({ minimum: 0, maximum: 65_535 });
const localWorkspaceSchema = Type.Object({
  deployment: Type.Literal("local"),
});
const gcpWorkspaceSchema = Type.Object({
  deployment: Type.Literal("gcp"),
  instanceTemplate: Type.String({ minLength: 1 }),
  projectId: Type.String({ minLength: 1 }),
  zone: Type.String({ minLength: 1 }),
});
const exeWorkspaceSchema = Type.Object({
  deployment: Type.Literal("exe"),
  templateVmName: Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
  workspaceTag: Type.Optional(
    Type.String({ pattern: "^[a-z][a-z0-9-]{0,62}$" }),
  ),
  privateKeyPath: Type.String({ minLength: 1 }),
  gatewaySecret: Type.String({ minLength: 32 }),
});

const gmailSchema = Type.Object({
  topic: Type.String({ pattern: "^projects/[^/]+/topics/[^/]+$" }),
  audience: Type.String({ minLength: 1 }),
  serviceAccount: Type.String({ minLength: 1 }),
});

// Deployment-owned administrator accounts. Campaign records live in the database.
const marketingAdminUserIdsSchema = Type.Array(
  Type.String({ minLength: 1, maxLength: 256 }),
  { uniqueItems: true },
);
// Explicit marketing hostnames and homepage origins contain no paths or credentials.
const marketingDomainPattern =
  "(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?";
const marketingHostnameSchema = Type.String({
  maxLength: 253,
  pattern: `^${marketingDomainPattern}$`,
});
const marketingHomepageOriginSchema = Type.String({
  maxLength: 262,
  pattern: `^https://${marketingDomainPattern}/?$`,
});

export const controlPlaneConfigSchema = Type.Union([
  Type.Object({
    deployment: Type.Literal("local"),
    appDataDir: Type.String(),
    port: portSchema,
    origin: Type.Optional(Type.String({ pattern: "^https://" })),
    auth: authSchema,
    github: Type.Optional(githubSchema),
    gmail: Type.Optional(gmailSchema),
    googleAnalyticsMeasurementId: Type.Optional(
      Type.String({ pattern: "^G-[A-Z0-9]+$" }),
    ),
    environment: Type.Optional(environmentSchema),
    marketingAdminUserIds: Type.Optional(marketingAdminUserIdsSchema),
    marketingHostname: Type.Optional(marketingHostnameSchema),
    marketingHomepageOrigin: Type.Optional(marketingHomepageOriginSchema),
    workspaceUpdates: Type.Optional(
      Type.Object({
        image: Type.String({
          pattern: "^[a-z0-9.-]+/[^ ]+@sha256:[a-f0-9]{64}$",
        }),
        imagePuller: Type.String({ minLength: 1 }),
      }),
    ),
    workspace: Type.Union([localWorkspaceSchema, exeWorkspaceSchema]),
  }),
  Type.Object({
    deployment: Type.Literal("cloudRun"),
    port: portSchema,
    origin: Type.String({ pattern: "^https://" }),
    databaseUrl: Type.String({ minLength: 1 }),
    traceBucket: Type.String({ minLength: 1 }),
    workspaceServiceAccount: Type.String({ minLength: 1 }),
    auth: authSchema,
    github: Type.Optional(githubSchema),
    gmail: Type.Optional(gmailSchema),
    googleAnalyticsMeasurementId: Type.Optional(
      Type.String({ pattern: "^G-[A-Z0-9]+$" }),
    ),
    environment: Type.Optional(environmentSchema),
    marketingAdminUserIds: Type.Optional(marketingAdminUserIdsSchema),
    marketingHostname: Type.Optional(marketingHostnameSchema),
    marketingHomepageOrigin: Type.Optional(marketingHomepageOriginSchema),
    workspaceUpdates: Type.Optional(
      Type.Object({
        image: Type.String({
          pattern: "^[a-z0-9.-]+/[^ ]+@sha256:[a-f0-9]{64}$",
        }),
        imagePuller: Type.String({ minLength: 1 }),
      }),
    ),
    workspace: Type.Union([gcpWorkspaceSchema, exeWorkspaceSchema]),
  }),
]);

export type ControlPlaneConfig = Static<typeof controlPlaneConfigSchema>;

export type ControlPlaneApplicationConfig = {
  mode: ApplicationMode;
  server: ControlPlaneConfig;
  inferenceApiKey: string;
  integrationEncryptionKey: Buffer;
};

interface AuthSecretIds {
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}

interface AuthConfiguration {
  secret: string;
  googleClientId: string;
  googleClientSecret: string;
}

class ControlPlaneConfigError extends errore.createTaggedError({
  name: "ControlPlaneConfigError",
  message: "Control plane configuration failed: $detail",
}) {}

export async function readControlPlaneConfig(): Promise<
  ControlPlaneApplicationConfig | Error
> {
  const configPath = process.argv[2];
  const server =
    configPath !== undefined
      ? await readConfigFile(configPath)
      : process.env.K_SERVICE === undefined
        ? await readDevelopmentConfig()
        : await readCloudRunConfig();
  if (server instanceof Error) return server;
  const inferenceApiKey = await readGcpSecret({
    projectId: secretProjectId,
    secretId: "together-ai-api-key",
  });
  if (inferenceApiKey instanceof Error) return inferenceApiKey;
  const integrationEncryptionKey = await readIntegrationEncryptionKey();
  if (integrationEncryptionKey instanceof Error)
    return integrationEncryptionKey;
  return {
    mode:
      configPath === undefined && process.env.K_SERVICE === undefined
        ? ApplicationMode.Development
        : ApplicationMode.Production,
    server,
    inferenceApiKey,
    integrationEncryptionKey,
  };
}

async function readIntegrationEncryptionKey() {
  const encoded = await readGcpSecret({
    projectId: secretProjectId,
    secretId: "halo-control-plane-integration-credential-key",
  });
  if (encoded instanceof Error) return encoded;
  const key = Buffer.from(encoded.trim(), "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded.trim())
    return new ControlPlaneConfigError({
      detail: "integration key must be 32 bytes encoded as base64",
    });
  return key;
}

async function readConfigFile(configPath: string) {
  const raw = await fs.readFile(configPath, "utf8").catch(
    (cause) =>
      new ControlPlaneConfigError({
        detail: "read configuration file",
        cause,
      }),
  );
  if (raw instanceof Error) return raw;
  return parseConfig(raw, "configuration file");
}

function parseConfig(raw: string, source: string): ControlPlaneConfig | Error {
  const parsed = errore.try({
    // SAFETY: JSON.parse is untyped; controlPlaneConfigSchema validates the result below.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new ControlPlaneConfigError({ detail: `parse ${source}`, cause }),
  });
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(controlPlaneConfigSchema, parsed))
    return new ControlPlaneConfigError({ detail: `validate ${source}` });
  return parsed;
}

async function readAuthConfiguration(
  secretIds: AuthSecretIds,
): Promise<AuthConfiguration | Error> {
  const [secret, googleClientId, googleClientSecret] = await Promise.all([
    readGcpSecret({ projectId: secretProjectId, secretId: secretIds.secret }),
    readGcpSecret({
      projectId: secretProjectId,
      secretId: secretIds.googleClientId,
    }),
    readGcpSecret({
      projectId: secretProjectId,
      secretId: secretIds.googleClientSecret,
    }),
  ]);
  if (secret instanceof Error) return secret;
  if (googleClientId instanceof Error) return googleClientId;
  if (googleClientSecret instanceof Error) return googleClientSecret;
  return { secret, googleClientId, googleClientSecret };
}

async function readDevelopmentConfig(): Promise<ControlPlaneConfig | Error> {
  const publicUrl = process.env.PUBLIC_URL;
  const origin =
    publicUrl === undefined
      ? undefined
      : errore.try({
          try: () => new URL(publicUrl),
          catch: (cause) =>
            new ControlPlaneConfigError({ detail: "parse PUBLIC_URL", cause }),
        });
  if (origin instanceof Error) return origin;
  if (
    origin !== undefined &&
    (origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== "")
  )
    return new ControlPlaneConfigError({
      detail:
        "PUBLIC_URL must be an HTTPS origin without credentials or a path",
    });
  const auth = await readAuthConfiguration(developmentAuthSecretIds);
  if (auth instanceof Error) return auth;
  const github = await readGithubConfiguration();
  if (github instanceof Error) return github;
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const configuredDataDir = process.env.HALO_USER_DATA;
  const marketingAdminUserIds = await readMarketingAdminUserIds();
  if (marketingAdminUserIds instanceof Error) return marketingAdminUserIds;
  const server = {
    marketingAdminUserIds,
    marketingHostname: process.env.HALO_MARKETING_HOSTNAME,
    marketingHomepageOrigin: process.env.HALO_MARKETING_HOMEPAGE_ORIGIN,
    deployment: "local" as const,
    appDataDir:
      configuredDataDir === undefined
        ? path.join(repositoryRoot, ".halo")
        : path.resolve(configuredDataDir),
    port: developmentPort,
    origin: origin?.origin,
    googleAnalyticsMeasurementId: process.env.GOOGLE_ANALYTICS_MEASUREMENT_ID, // coverage-exempt: Bootstrap reads live Secret Manager credentials; the schema and HTTP configuration contract are tested.
    environment: process.env.HALO_ENVIRONMENT ?? "development", // coverage-exempt: Bootstrap reads live Secret Manager credentials; the schema and HTTP configuration contract are tested.
    auth,
    github,
    workspace: { deployment: "local" as const },
  };
  if (!Value.Check(controlPlaneConfigSchema, server))
    return new ControlPlaneConfigError({
      detail: "validate development configuration",
    });
  return server;
}

async function readCloudRunConfig(): Promise<ControlPlaneConfig | Error> {
  const portValue = process.env.PORT;
  if (portValue === undefined)
    return new ControlPlaneConfigError({ detail: "set PORT" });
  const origin = process.env.BETTER_AUTH_URL;
  if (origin === undefined)
    return new ControlPlaneConfigError({ detail: "set BETTER_AUTH_URL" });
  const databaseUrlSecretId = process.env.DATABASE_URL_SECRET_ID;
  if (databaseUrlSecretId === undefined)
    return new ControlPlaneConfigError({
      detail: "set DATABASE_URL_SECRET_ID",
    });
  const authSecretId = process.env.BETTER_AUTH_SECRET_ID;
  if (authSecretId === undefined)
    return new ControlPlaneConfigError({
      detail: "set BETTER_AUTH_SECRET_ID",
    });
  const googleClientIdSecretId = process.env.GOOGLE_CLIENT_ID_SECRET_ID;
  if (googleClientIdSecretId === undefined)
    return new ControlPlaneConfigError({
      detail: "set GOOGLE_CLIENT_ID_SECRET_ID",
    });
  const googleClientSecretId = process.env.GOOGLE_CLIENT_SECRET_ID;
  if (googleClientSecretId === undefined)
    return new ControlPlaneConfigError({
      detail: "set GOOGLE_CLIENT_SECRET_ID",
    });
  const workspace = await readCloudWorkspaceConfig();
  if (workspace instanceof Error) return workspace;

  const databaseUrl = await readGcpSecret({
    projectId: secretProjectId,
    secretId: databaseUrlSecretId,
  });
  if (databaseUrl instanceof Error) return databaseUrl;
  const auth = await readAuthConfiguration({
    secret: authSecretId,
    googleClientId: googleClientIdSecretId,
    googleClientSecret: googleClientSecretId,
  });
  if (auth instanceof Error) return auth;
  const github = await readGithubConfiguration();
  if (github instanceof Error) return github;
  const marketingAdminUserIds = await readMarketingAdminUserIds();
  if (marketingAdminUserIds instanceof Error) return marketingAdminUserIds;
  const updateImage = process.env.WORKSPACE_UPDATE_IMAGE;
  const imagePuller = process.env.WORKSPACE_UPDATE_IMAGE_PULLER;
  const workspaceUpdates =
    updateImage !== undefined &&
    /^[a-z0-9.-]+\/[^\s]+@sha256:[a-f0-9]{64}$/.test(updateImage) &&
    imagePuller
      ? { image: updateImage, imagePuller }
      : undefined;
  if (updateImage !== undefined && workspaceUpdates === undefined)
    console.warn(
      "Workspace updates disabled: configure a digest-pinned image and image reader account.",
    );
  const server = {
    marketingAdminUserIds,
    marketingHostname: process.env.HALO_MARKETING_HOSTNAME,
    marketingHomepageOrigin: process.env.HALO_MARKETING_HOMEPAGE_ORIGIN,
    deployment: "cloudRun" as const,
    port: Number(portValue),
    origin,
    databaseUrl,
    googleAnalyticsMeasurementId: process.env.GOOGLE_ANALYTICS_MEASUREMENT_ID, // coverage-exempt: Bootstrap reads live Secret Manager credentials; the schema and HTTP configuration contract are tested.
    environment: process.env.HALO_ENVIRONMENT, // coverage-exempt: Bootstrap reads live Secret Manager credentials; the schema and HTTP configuration contract are tested.
    traceBucket: process.env.TRACE_BUCKET,
    gmail:
      process.env.GMAIL_PUBSUB_TOPIC === undefined
        ? undefined
        : {
            topic: process.env.GMAIL_PUBSUB_TOPIC,
            audience: `${origin}/api/automation-events/gmail`,
            serviceAccount: process.env.GMAIL_PUSH_SERVICE_ACCOUNT,
          },
    workspaceServiceAccount: process.env.WORKSPACE_SERVICE_ACCOUNT,
    github,
    auth: {
      ...auth,
      signInAllowlistSecretId: process.env.SIGN_IN_ALLOWLIST_SECRET_ID,
      stagingTestersSecretId: process.env.STAGING_TESTERS_SECRET_ID,
    },
    workspace,
    workspaceUpdates,
  };
  if (!Value.Check(controlPlaneConfigSchema, server))
    return new ControlPlaneConfigError({
      detail: "validate Cloud Run configuration",
    });
  return server;
}

async function readGithubConfiguration() {
  const clientIdSecretId = process.env.GITHUB_CLIENT_ID_SECRET_ID;
  const clientSecretSecretId = process.env.GITHUB_CLIENT_SECRET_ID;
  if (clientIdSecretId === undefined && clientSecretSecretId === undefined)
    return undefined;
  if (!clientIdSecretId || !clientSecretSecretId)
    return new ControlPlaneConfigError({
      detail: "set both GITHUB_CLIENT_ID_SECRET_ID and GITHUB_CLIENT_SECRET_ID",
    });
  const [clientId, clientSecret] = await Promise.all([
    readControlPlaneSecret(clientIdSecretId),
    readControlPlaneSecret(clientSecretSecretId),
  ]);
  if (clientId instanceof Error) return clientId;
  if (clientSecret instanceof Error) return clientSecret;
  return { clientId: clientId.trim(), clientSecret: clientSecret.trim() };
}

async function readCloudWorkspaceConfig() {
  const provider = process.env.WORKSPACE_PROVIDER ?? "gcp";
  if (provider === "exe") {
    const gatewaySecretId = process.env.EXE_GATEWAY_SECRET_ID;
    if (gatewaySecretId === undefined)
      return new ControlPlaneConfigError({
        detail: "set EXE_GATEWAY_SECRET_ID",
      });
    const gatewaySecret = await readGcpSecret({
      projectId: secretProjectId,
      secretId: gatewaySecretId,
    });
    if (gatewaySecret instanceof Error) return gatewaySecret;
    const workspace = {
      deployment: "exe" as const,
      templateVmName: process.env.EXE_TEMPLATE_VM_NAME,
      workspaceTag: process.env.EXE_WORKSPACE_TAG,
      privateKeyPath: process.env.EXE_PRIVATE_KEY_PATH,
      gatewaySecret,
    };
    if (!Value.Check(exeWorkspaceSchema, workspace))
      return new ControlPlaneConfigError({
        detail: "validate Exe workspace configuration",
      });
    return workspace;
  }
  if (provider !== "gcp")
    return new ControlPlaneConfigError({
      detail: "WORKSPACE_PROVIDER must be gcp or exe",
    });
  const workspace = {
    deployment: "gcp" as const,
    projectId: process.env.WORKSPACE_PROJECT_ID,
    zone: process.env.WORKSPACE_ZONE,
    instanceTemplate: process.env.WORKSPACE_INSTANCE_TEMPLATE,
  };
  if (!Value.Check(gcpWorkspaceSchema, workspace))
    return new ControlPlaneConfigError({
      detail: "validate GCP workspace configuration",
    });
  return workspace;
}

/** Reads a control-plane secret from the Halo project's Secret Manager. */
export async function readControlPlaneSecret(secretId: string) {
  return await readGcpSecret({ projectId: secretProjectId, secretId });
}

async function readMarketingAdminUserIds() {
  const secretId = process.env.HALO_MARKETING_ADMIN_USER_IDS_SECRET_ID;
  const raw =
    secretId === undefined
      ? process.env.HALO_MARKETING_ADMIN_USER_IDS
      : await readControlPlaneSecret(secretId);
  if (raw instanceof Error) return raw;
  if (raw === undefined) return [];
  const parsed = errore.try({
    // SAFETY: Parsed environment data is validated before use.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new ControlPlaneConfigError({
        detail: "parse HALO_MARKETING_ADMIN_USER_IDS",
        cause,
      }),
  });
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(marketingAdminUserIdsSchema, parsed))
    return new ControlPlaneConfigError({
      detail:
        "HALO_MARKETING_ADMIN_USER_IDS must be a JSON array of unique Halo user IDs",
    });
  return parsed;
}
