import * as errore from "errore";
import { checkServerCompatibility, type ServerInfo } from "@get-halo/client";
import { error, oc, type, type RouterContractClient } from "@orpc/contract";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  appAccessSchema,
  appActionSchema,
  appSlugSchema,
  type AppSummary,
  type TemplateSummary,
} from "./extensionSharing.js";

import {
  marketingCampaignSchema,
  marketingSlugSchema,
  marketingTagsSchema,
  type MarketingCampaign,
} from "./marketingCampaign.js";

const jsonValueSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(self),
    Type.Record(Type.String(), self),
  ]),
);
export type IntegrationJson = Static<typeof jsonValueSchema>;
export type IntegrationSetupMethod = {
  template: string;
  label: string;
  kind: "oauth" | "apikey" | "header" | "none";
  fields: string[];
};
export type IntegrationSetupCatalogEntry = {
  integration: string;
  name: string;
  methods: IntegrationSetupMethod[];
};
export type IntegrationSetup = IntegrationSetupCatalogEntry & {
  setupId: string;
  connectionName: string;
  // The Halo account that receives the connection, when Halo opened the page.
  owner?: string;
  status:
    | "awaiting_credentials"
    | "authorizing"
    | "confirming"
    | "ready"
    | "cancelled"
    | "expired"
    | "failed";
  connection?: IntegrationConnection;
  message?: string;
};
// What happened to the provider's grant when a connection was removed.
export type ConnectionRevocation =
  // The provider no longer grants Halo access to the account.
  | "revoked"
  // Another connection uses the same grant, so access was kept for it.
  | "shared"
  // Halo cannot revoke access for this kind of connection.
  | "not_supported"
  // The provider did not confirm the revocation.
  | "failed";
export type IntegrationConnection = {
  address: string;
  integration: string;
  name: string;
  accountLabel?: string;
};
export type IntegrationTool = {
  address: string;
  integration: string;
  connection: string;
  name: string;
  description: string;
};
export type IntegrationToolSchema = IntegrationTool & {
  inputSchema?: IntegrationJson;
  outputSchema?: IntegrationJson;
  schemaDefinitions?: IntegrationJson;
  inputTypeScript?: string;
  outputTypeScript?: string;
  requiresApproval?: boolean;
};
export type IntegrationInvocation =
  | { status: "completed"; result: IntegrationJson }
  | { status: "blocked" | "approval_required" }
  | {
      status: "connection_required";
      integration: string;
      connectionName?: string;
    }
  | {
      status: "failed";
      code: "tool_failed" | "unsupported_interaction" | "outcome_unknown";
      message: string;
    };

export const registerApiInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    slug: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    url: Type.String({ minLength: 1, maxLength: 2048 }),
    googleOAuthScopes: Type.Optional(
      Type.Array(
        Type.String({ minLength: 1, maxLength: 2048, pattern: "\\S" }),
        {
          minItems: 1,
          maxItems: 64,
          uniqueItems: true,
          description:
            "Optional Google OAuth permissions for an official Google Discovery URL. Choose scopes declared in the API description and request only the access needed for the user’s task. Operations requiring other scopes are omitted.",
        },
      ),
    ),
  },
  { additionalProperties: false },
);
export type ApiRegistration = Static<typeof registerApiInputSchema>;

export const registerMcpInputSchema = Type.Object(
  {
    name: Type.String({ minLength: 1, maxLength: 256 }),
    slug: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
    endpoint: Type.String({ minLength: 1, maxLength: 2048 }),
    auth: Type.Union([
      Type.Literal("none"),
      Type.Literal("bearer"),
      Type.Literal("oauth"),
    ]),
  },
  { additionalProperties: false },
);
export type McpRegistration = Static<typeof registerMcpInputSchema>;

export class IntegrationRegistrationError extends errore.createTaggedError({
  name: "IntegrationRegistrationError",
  message: "$reason",
}) {
  constructor(ctx: { cause: unknown }) {
    super({
      reason:
        ctx.cause instanceof Error
          ? ctx.cause.message
          : "Integration registration failed",
      cause: ctx.cause,
    });
  }
}

function validated<T extends TSchema>(schema: T) {
  return {
    "~standard": {
      version: 1 as const,
      vendor: "halo-typebox",
      validate: (
        // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Standard Schema receives untrusted RPC input here.
        value: unknown,
      ): { value: Static<T> } | { issues: { message: string }[] } =>
        Value.Check(schema, value)
          ? { value }
          : { issues: [{ message: "Invalid integration request" }] },
    },
  };
}

// Version 6 adds published apps.
export const controlPlaneProtocolVersion = 6 as const;
// Protocol 3 exposes the unchanged auth/workspace APIs, without integrations;
// protocol 5 clients predate published apps.
export const controlPlaneSupportedProtocols = [
  3,
  5,
  controlPlaneProtocolVersion,
];

export type ControlPlaneSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
  };
  user: {
    id: string;
    email: string;
    name: string;
    image?: string;
  };
  /** Offers the desktop staging toggle; older control planes omit it. */
  stagingAccess?: boolean;
};

export type DesktopAuthSession = ControlPlaneSession & {
  token: string;
};

export type ControlPlaneAuthentication =
  | { status: "signed-out" }
  | { status: "signed-in"; session: ControlPlaneSession };

export type WorkspaceUpdateStatus = {
  state:
    | "current"
    | "available"
    | "downloading"
    | "ready"
    | "upgrading"
    | "failed";
  version: string;
  targetVersion: string;
  busy: boolean;
  reportedAt: number;
  error?: string;
};
export type WorkspaceUpgradeResult = {
  status: "current" | "started" | "busy" | "checking";
};

/** VM lifecycle and maintenance remain available while its server restarts. */
export type ControlPlaneWorkspaceStatus = {
  status: "running" | "sleeping" | "asleep" | "waking";
  update?: WorkspaceUpdateStatus;
};

export type ControlPlaneWorkspace = {
  id: string;
  createdAt: string;
};

export const ControlPlaneRequestError = error("BAD_REQUEST", {
  message: "The control plane could not complete the request.",
  data: type<{ message: string }>(),
});

const publicProcedure = oc.errors({
  [ControlPlaneRequestError.code]: ControlPlaneRequestError,
});

const authenticatedProcedure = publicProcedure.errors({
  UNAUTHORIZED: {},
});

const appIdSchema = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const appSourceNameSchema = Type.String({ minLength: 1, maxLength: 1024 });

export const controlPlaneContract = publicProcedure.router({
  server: {
    info: oc.output(type<ServerInfo>()),
  },
  auth: {
    start: publicProcedure
      .input(type<{ callback: string; state: string }>())
      .output(type<{ authorizationUrl: string }>()),
    exchange: publicProcedure
      .input(type<{ code: string }>())
      .output(type<DesktopAuthSession>()),
    session: publicProcedure.output(type<ControlPlaneAuthentication>()),
  },
  marketing: {
    create: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { slug: marketingSlugSchema, tags: marketingTagsSchema },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<MarketingCampaign>()),
    list: authenticatedProcedure.output(type<MarketingCampaign[]>()),
    update: authenticatedProcedure
      .input(validated(marketingCampaignSchema))
      .output(type<MarketingCampaign>()),
    remove: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { slug: marketingSlugSchema },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<void>()),
  },
  workspace: {
    status: authenticatedProcedure.output(type<ControlPlaneWorkspaceStatus>()),
    cancelUpgrade: authenticatedProcedure.output(type<void>()),
    upgrade: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { force: Type.Boolean() },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<WorkspaceUpgradeResult>()),
    ensure: authenticatedProcedure.output(type<ControlPlaneWorkspace>()),
    rotateRuntimeToken:
      authenticatedProcedure.output(type<ControlPlaneWorkspace>()),
  },
  integrations: {
    catalog:
      authenticatedProcedure.output(type<IntegrationSetupCatalogEntry[]>()),
    startSetup: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              integration: Type.String({ minLength: 1, maxLength: 256 }),
              connectionName: Type.Optional(
                Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_-]{0,63}$" }),
              ),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ setupId: string; setupUrl: string }>()),
    setup: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { setupId: Type.String({ minLength: 1, maxLength: 128 }) },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<IntegrationSetup>()),
    submitSetup: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              setupId: Type.String({ minLength: 1, maxLength: 128 }),
              template: Type.String({ minLength: 1, maxLength: 256 }),
              values: Type.Optional(
                Type.Record(
                  Type.String({ maxLength: 128 }),
                  Type.String({ maxLength: 65536 }),
                ),
              ),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ authorizationUrl?: string }>()),
    cancelSetup: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { setupId: Type.String({ minLength: 1, maxLength: 128 }) },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<void>()),
    // Signed-in Halo clients issue a single-use link for the browser they open.
    createSetupHandoff: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { setupId: Type.String({ minLength: 1, maxLength: 128 }) },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ url: string }>()),
    // Binds the redeeming browser to the setup with a cookie.
    redeemSetupHandoff: publicProcedure
      .input(
        validated(
          Type.Object(
            {
              setupId: Type.String({ minLength: 1, maxLength: 128 }),
              handoff: Type.String({ minLength: 1, maxLength: 128 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<void>()),
    // Removes a connection, its tools and its stored credentials.
    removeConnection: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              integration: Type.String({ minLength: 1, maxLength: 256 }),
              name: Type.String({ minLength: 1, maxLength: 128 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ revocation: ConnectionRevocation }>()),
    // Keep the RPC route stable for released clients; agents use executor.integrations.registerApi.
    registerOpenAPI: authenticatedProcedure
      .input(validated(registerApiInputSchema))
      .output(type<void>()),
    registerMcp: authenticatedProcedure
      .input(validated(registerMcpInputSchema))
      .output(type<void>()),
    connections: authenticatedProcedure.output(type<IntegrationConnection[]>()),
    search: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              query: Type.String({ maxLength: 1024 }),
              integration: Type.Optional(
                Type.String({ minLength: 1, maxLength: 256 }),
              ),
              limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ tools: IntegrationTool[]; truncated: boolean }>()),
    describe: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              address: Type.String({ minLength: 1, maxLength: 2048 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<IntegrationToolSchema>()),
    invoke: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              address: Type.String({ minLength: 1, maxLength: 2048 }),
              arguments: Type.Record(Type.String(), jsonValueSchema),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<IntegrationInvocation>()),
  },
  // Owner operations. Visitors reach apps only through the creator host.
  apps: {
    publisher:
      authenticatedProcedure.output(type<{ handle: string; origin: string }>()),
    checkPublisherHandle: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { handle: Type.String({ maxLength: 256 }) },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ available: boolean; reason?: string }>()),
    renamePublisher: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { handle: Type.String({ maxLength: 256 }) },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ handle: string; origin: string }>()),
    list: authenticatedProcedure.output(type<AppSummary[]>()),
    // Starts or resumes publication; the app VM becomes the only live copy.
    publish: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              extensionId: Type.String({ pattern: "^[a-z][a-z0-9-]{0,79}$" }),
              slug: Type.Optional(appSlugSchema),
              access: appAccessSchema,
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<AppSummary>()),
    update: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              appId: appIdSchema,
              access: Type.Optional(appAccessSchema),
              published: Type.Optional(Type.Boolean()),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<AppSummary>()),
    // Abandons a publication that has not completed; the local app resumes.
    cancel: authenticatedProcedure
      .input(
        validated(
          Type.Object({ appId: appIdSchema }, { additionalProperties: false }),
        ),
      )
      .output(type<void>()),
    remove: authenticatedProcedure
      .input(
        validated(
          Type.Object({ appId: appIdSchema }, { additionalProperties: false }),
        ),
      )
      .output(type<void>()),
    // Replaces fixed integration requests. Only the owner, never app code.
    bindActions: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              appId: appIdSchema,
              actions: Type.Array(appActionSchema, { maxItems: 32 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<AppSummary>()),
    readSource: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            { appId: appIdSchema, name: appSourceNameSchema },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<string>()),
    writeSource: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              appId: appIdSchema,
              name: appSourceNameSchema,
              contents: Type.String({ maxLength: 16 * 1024 * 1024 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<void>()),
    // Runs in the app VM's build container: source is writable, data is absent.
    execSource: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              appId: appIdSchema,
              command: Type.String({ minLength: 1, maxLength: 8192 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<{ output: string; exitCode: number }>()),
    restart: authenticatedProcedure
      .input(
        validated(
          Type.Object({ appId: appIdSchema }, { additionalProperties: false }),
        ),
      )
      .output(type<void>()),
    // Publishes a template with sample data and a per-visitor demo.
    publishTemplate: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              appId: appIdSchema,
              slug: appSlugSchema,
              description: Type.String({ minLength: 1, maxLength: 2000 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<TemplateSummary>()),
  },
});

export type ControlPlaneClient = RouterContractClient<
  typeof controlPlaneContract
>;

export async function checkControlPlaneCompatibility(
  client: ControlPlaneClient,
  signal?: AbortSignal,
) {
  const info = await client.server
    .info(undefined, { signal })
    .catch((cause) => new ControlPlaneConnectionError({ cause }));
  if (info instanceof Error) return info;
  return checkServerCompatibility({
    info,
    service: "control-plane",
    clientProtocolVersion: controlPlaneProtocolVersion,
  });
}

class ControlPlaneConnectionError extends errore.createTaggedError({
  name: "ControlPlaneConnectionError",
  message: "Could not check the control-plane API.",
}) {}
