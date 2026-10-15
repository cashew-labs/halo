import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

export const appJsonSchema = Type.Recursive((self) =>
  Type.Union([
    Type.Null(),
    Type.Boolean(),
    Type.Number(),
    Type.String(),
    Type.Array(self),
    Type.Record(Type.String(), self),
  ]),
);
export type AppJson = Static<typeof appJsonSchema>;

// An action binds a complete integration request, rather than giving visitors
// permission to choose another resource through arbitrary tool arguments.
export const appActionSchema = Type.Object(
  {
    name: Type.String({ pattern: "^[a-zA-Z][a-zA-Z0-9_]{0,63}$" }),
    description: Type.String({ minLength: 1, maxLength: 1024 }),
    address: Type.String({ minLength: 1, maxLength: 512 }),
    arguments: Type.Record(Type.String(), appJsonSchema),
    sampleResult: Type.Optional(appJsonSchema),
  },
  { additionalProperties: false },
);
export type AppAction = Static<typeof appActionSchema>;

export const appDefinitionSchema = Type.Object(
  {
    description: Type.String({ minLength: 1, maxLength: 4096 }),
    sync: Type.Union([
      Type.Literal("read-only"),
      Type.Literal("shared"),
      Type.Literal("actions"),
    ]),
    actions: Type.Array(appActionSchema, { maxItems: 32 }),
    instructions: Type.Optional(Type.String({ maxLength: 16384 })),
  },
  { additionalProperties: false },
);
export type AppDefinition = Static<typeof appDefinitionSchema>;

export type AppAccess = { visibility: "public" | "invited"; members: string[] };
export const appAccessSchema = Type.Object(
  {
    visibility: Type.Union([Type.Literal("public"), Type.Literal("invited")]),
    members: Type.Array(
      Type.String({
        maxLength: 254,
        pattern: "^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$",
      }),
      { maxItems: 100 },
    ),
  },
  { additionalProperties: false },
);
export type AppPublication = AppAccess & {
  appId: string;
  extensionId: string;
  displayName: string;
  description: string;
  url: string;
  definition: AppDefinition;
};
export type { AppSummary } from "@get-halo/client";

export const appSlugSchema = Type.String({
  pattern: "^[a-z][a-z0-9-]{0,62}$",
});

export type AppViewer = {
  viewerId: string;
  role: "owner" | "member" | "public";
  email?: string;
};

export type TemplateArtifact = {
  files: Record<string, string>;
  // Compiled files are base64 encoded; source files remain plain UTF-8.
  build: Record<string, string>;
};
export type TemplatePublication = {
  templateId: string;
  displayName: string;
  description: string;
  author: string;
  url: string;
  demoUrl: string;
};

export class AppDefinitionError extends errore.createTaggedError({
  name: "AppDefinitionError",
  message: "Cannot publish app: $reason",
}) {}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- App manifests are untrusted JSON at this validation boundary.
export function validateAppDefinition(input: unknown) {
  if (!Value.Check(appDefinitionSchema, input))
    return new AppDefinitionError({ reason: "invalid app definition" });
  const names = new Set(input.actions.map((action) => action.name));
  if (names.size !== input.actions.length)
    return new AppDefinitionError({ reason: "action names must be unique" });
  if (
    input.actions.some(
      (action) =>
        !/^[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_.-]+$/.test(
          action.address,
        ),
    )
  )
    return new AppDefinitionError({
      reason: "actions must name connected integration operations",
    });
  return input;
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Access lists arrive at an RPC validation boundary.
export function validateAppAccess(input: unknown) {
  if (!Value.Check(appAccessSchema, input))
    return new AppDefinitionError({ reason: "invalid access list" });
  return {
    visibility: input.visibility,
    members: [...new Set(input.members.map((email) => email.toLowerCase()))],
  };
}
