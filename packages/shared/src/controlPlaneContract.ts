import * as errore from "errore";
import { checkServerCompatibility, type ServerInfo } from "@get-halo/client";
import { error, oc, type, type RouterContractClient } from "@orpc/contract";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

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

// Version 5 adds confirming for a saved connection awaiting setup-status repair.
export const controlPlaneProtocolVersion = 5 as const;
// Protocol 3 exposes the unchanged auth/workspace APIs, without integrations.
export const controlPlaneSupportedProtocols = [3, controlPlaneProtocolVersion];

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
};

export type DesktopAuthSession = ControlPlaneSession & {
  token: string;
};

export type ControlPlaneAuthentication =
  | { status: "signed-out" }
  | { status: "signed-in"; session: ControlPlaneSession };

/** VM lifecycle only; the app separately tracks its workspace connection. */
export type ControlPlaneWorkspaceStatus = {
  status: "running" | "sleeping" | "asleep" | "waking";
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
  workspace: {
    status: authenticatedProcedure.output(type<ControlPlaneWorkspaceStatus>()),
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
    registerOpenAPI: authenticatedProcedure
      .input(
        validated(
          Type.Object(
            {
              name: Type.String({ minLength: 1, maxLength: 256 }),
              slug: Type.String({ pattern: "^[a-z][a-z0-9_-]{0,63}$" }),
              url: Type.String({ minLength: 1, maxLength: 2048 }),
            },
            { additionalProperties: false },
          ),
        ),
      )
      .output(type<void>()),
    registerMcp: authenticatedProcedure
      .input(
        validated(
          Type.Object(
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
          ),
        ),
      )
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
