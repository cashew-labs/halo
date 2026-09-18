import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { Model, ThinkingLevel } from "@earendil-works/pi-ai";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";
import { ApplicationMode } from "./ApplicationMode.js";
import { readGcpSecret } from "./readGcpSecret.js";

const inferenceProjectId = "halo-relay";
const inferenceLocation = "global";
// Pi reserves this credential value to select Vertex Application Default Credentials.
const vertexAdcMarker = "gcp-vertex-credentials";
const developmentUserSchema = Type.Object({
  id: Type.String({ minLength: 1 }),
});

export const workspaceServerConfigSchema = Type.Object({
  environment: Type.Union([Type.Literal("local"), Type.Literal("cloud")]),
  workspaceRoot: Type.String(),
  appDataDir: Type.String(),
  appVersion: Type.String(),
  ownerUserId: Type.String(),
  logFilePath: Type.String(),
  traceUpload: Type.Optional(
    Type.Object({
      origin: Type.String({ pattern: "^https://" }),
      workspaceId: Type.String({
        pattern:
          "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
      }),
    }),
  ),
  corsOrigins: Type.Array(Type.String()),
  gateway: Type.Optional(
    Type.Object({
      audience: Type.String({ minLength: 1 }),
      serviceAccountEmail: Type.String({ minLength: 1 }),
    }),
  ),
  port: Type.Integer({ minimum: 0, maximum: 65_535 }),
  cliEntry: Type.Optional(Type.String()),
  cliNodeExecutable: Type.Optional(Type.String()),
  cliElectronRunAsNode: Type.Optional(Type.Boolean()),
  extensionRuntime: Type.Optional(
    Type.Object({
      executable: Type.String(),
      electronRunAsNode: Type.Boolean(),
    }),
  ),
});

export type WorkspaceServerConfig = Static<typeof workspaceServerConfigSchema>;

type OpenAIInferenceConfig = {
  backend: "openAI";
  options: {
    model: Model<"openai-completions">;
    apiKey: string;
  };
};

type PiInferenceConfig = {
  backend: "pi";
  options: {
    agentDir: string;
    provider: string;
    modelId: string;
    apiKey: string;
    environment: Record<string, string>;
    reasoning: ThinkingLevel;
  };
};

export type WorkspaceServerApplicationConfig = {
  mode: ApplicationMode;
  server: WorkspaceServerConfig;
  inference: OpenAIInferenceConfig | PiInferenceConfig;
  googleWebOAuthClient: GoogleWebOAuthClient | undefined;
};

export type GoogleWebOAuthClient = {
  clientId: string;
  clientSecret: string;
};

class WorkspaceServerConfigError extends errore.createTaggedError({
  name: "WorkspaceServerConfigError",
  message: "Workspace server configuration failed: $detail",
}) {}

async function readConfig(): Promise<WorkspaceServerApplicationConfig | Error> {
  const configPath = process.argv[2];
  const server =
    configPath === undefined
      ? await readDevelopmentConfig()
      : await readConfigFile(configPath);
  if (server instanceof Error) return server;
  const inference = readInferenceConfig(server.workspaceRoot);
  if (inference instanceof Error) return inference;
  const googleWebOAuthClient = await readGoogleWebOAuthClient(
    server.environment,
  );
  if (googleWebOAuthClient instanceof Error) return googleWebOAuthClient;
  const mode =
    configPath === undefined
      ? ApplicationMode.Development
      : process.env.HALO_E2E === "1"
        ? ApplicationMode.Test
        : ApplicationMode.Production;
  return { mode, server, inference, googleWebOAuthClient };
}

async function readGoogleWebOAuthClient(environment: "local" | "cloud") {
  if (environment === "local") {
    const clientId = process.env.HALO_GOOGLE_WEB_CLIENT_ID;
    const clientSecret = process.env.HALO_GOOGLE_WEB_CLIENT_SECRET;
    if (clientId === undefined && clientSecret === undefined) return undefined;
    if (clientId === undefined)
      return new WorkspaceServerConfigError({
        detail: "set HALO_GOOGLE_WEB_CLIENT_ID",
      });
    if (clientSecret === undefined)
      return new WorkspaceServerConfigError({
        detail: "set HALO_GOOGLE_WEB_CLIENT_SECRET",
      });
    return { clientId, clientSecret };
  }

  const clientIdSecretId = process.env.GOOGLE_WEB_CLIENT_ID_SECRET_ID;
  if (clientIdSecretId === undefined)
    return new WorkspaceServerConfigError({
      detail: "set GOOGLE_WEB_CLIENT_ID_SECRET_ID",
    });
  const clientSecretSecretId = process.env.GOOGLE_WEB_CLIENT_SECRET_ID;
  if (clientSecretSecretId === undefined)
    return new WorkspaceServerConfigError({
      detail: "set GOOGLE_WEB_CLIENT_SECRET_ID",
    });
  const [clientId, clientSecret] = await Promise.all([
    readGcpSecret({
      projectId: inferenceProjectId,
      secretId: clientIdSecretId,
    }),
    readGcpSecret({
      projectId: inferenceProjectId,
      secretId: clientSecretSecretId,
    }),
  ]);
  if (clientId instanceof Error) return clientId;
  if (clientSecret instanceof Error) return clientSecret;
  return { clientId, clientSecret };
}

async function readConfigFile(configPath: string) {
  const raw = await fsPromises.readFile(configPath, "utf8").catch(
    (cause) =>
      new WorkspaceServerConfigError({
        detail: "read configuration file",
        cause,
      }),
  );
  if (raw instanceof Error) return raw;
  return parseServerConfig(raw, "configuration file");
}

function parseServerConfig(
  raw: string,
  source: string,
): WorkspaceServerConfig | Error {
  const parsed = errore.try({
    // SAFETY: JSON.parse is untyped; workspaceServerConfigSchema validates the result below.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new WorkspaceServerConfigError({ detail: `parse ${source}`, cause }),
  });
  if (parsed instanceof Error) return parsed;
  if (!Value.Check(workspaceServerConfigSchema, parsed))
    return new WorkspaceServerConfigError({ detail: `validate ${source}` });
  return parsed;
}

async function readDevelopmentConfig(): Promise<WorkspaceServerConfig | Error> {
  const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
  const workspaceRoot = process.env.HALO_WORKSPACE_ROOT;
  if (workspaceRoot === undefined)
    return new WorkspaceServerConfigError({
      detail: "set HALO_WORKSPACE_ROOT or pass a configuration JSON file",
    });
  const configuredDataDir = process.env.HALO_USER_DATA;
  const appDataDir =
    configuredDataDir === undefined
      ? path.join(repositoryRoot, ".halo")
      : path.resolve(configuredDataDir);
  const ownerUserId = await readDevelopmentUserId(appDataDir);
  if (ownerUserId instanceof Error) return ownerUserId;
  const rendererPort = process.env.HALO_RENDERER_PORT;
  const rendererOrigin = `http://localhost:${rendererPort === undefined ? "1420" : rendererPort}`;
  return {
    environment: "local",
    workspaceRoot: path.resolve(workspaceRoot),
    appDataDir,
    appVersion: "0.0.0",
    ownerUserId,
    logFilePath: path.join(appDataDir, "logs", "server.jsonl"),
    corsOrigins: [rendererOrigin, "null"],
    port: 0,
    cliEntry: path.join(
      repositoryRoot,
      "packages",
      "halo-cli",
      "src",
      "cli.ts",
    ),
    cliNodeExecutable: process.execPath,
    extensionRuntime: {
      executable: process.execPath,
      electronRunAsNode: false,
    },
  };
}

async function readDevelopmentUserId(appDataDir: string) {
  const userPath = path.join(appDataDir, "user.json");
  if (fs.existsSync(userPath)) {
    const existing = await readExistingDevelopmentUserId(userPath);
    if (existing !== undefined) return existing;
  }

  const userId = randomUUID();
  const created = await fsPromises
    .mkdir(appDataDir, { recursive: true, mode: 0o700 })
    .catch(
      (cause) =>
        new WorkspaceServerConfigError({
          detail: "create application data directory",
          cause,
        }),
    );
  if (created instanceof Error) return created;
  const written = await fsPromises
    .writeFile(userPath, `${JSON.stringify({ id: userId }, undefined, 2)}\n`, {
      mode: 0o600,
    })
    .catch(
      (cause) =>
        new WorkspaceServerConfigError({
          detail: "write development user",
          cause,
        }),
    );
  if (written instanceof Error) return written;
  return userId;
}

async function readExistingDevelopmentUserId(userPath: string) {
  const raw = await fsPromises.readFile(userPath, "utf8").catch(
    (cause) =>
      new WorkspaceServerConfigError({
        detail: "read development user",
        cause,
      }),
  );
  if (raw instanceof Error) {
    console.warn("Invalid user.json:", raw.message);
    return;
  }
  const parsed = errore.try({
    // SAFETY: JSON.parse is untyped; developmentUserSchema validates the result below.
    try: () => JSON.parse(raw) as unknown,
    catch: (cause) =>
      new WorkspaceServerConfigError({
        detail: "parse development user",
        cause,
      }),
  });
  if (parsed instanceof Error) {
    console.warn("Invalid user.json:", parsed.message);
    return;
  }
  if (!Value.Check(developmentUserSchema, parsed)) {
    const invalid = new WorkspaceServerConfigError({
      detail: "validate development user",
    });
    console.warn("Invalid user.json:", invalid.message);
    return;
  }
  return parsed.id;
}

function readInferenceConfig(
  workspaceRoot: string,
): OpenAIInferenceConfig | PiInferenceConfig | Error {
  const configured = process.env.HALO_LLM_CONFIG;
  if (configured !== undefined) {
    const options = errore.try({
      // SAFETY: The host supplies serialized OpenAI inference launch configuration.
      try: () => JSON.parse(configured) as OpenAIInferenceConfig["options"],
      catch: (cause) =>
        new WorkspaceServerConfigError({
          detail: "parse HALO_LLM_CONFIG",
          cause,
        }),
    });
    if (options instanceof Error) return options;
    return { backend: "openAI", options };
  }

  return {
    backend: "pi",
    options: {
      agentDir: path.join(workspaceRoot, ".pi", "agent"),
      provider: "google-vertex",
      modelId: "gemini-3.8-flash",
      apiKey: vertexAdcMarker,
      environment: {
        GOOGLE_CLOUD_PROJECT: inferenceProjectId,
        GOOGLE_CLOUD_LOCATION: inferenceLocation,
      },
      reasoning: "low",
    },
  };
}

export const config = await readConfig();
