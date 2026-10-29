import { Type, type Static } from "@sinclair/typebox";
import type { WorkspaceSchema } from "./database/schema/workspaceSchema.js";

// Limits count string length, as TypeBox maxLength does.
export const memoryScopes = {
  user: {
    title: "User",
    limit: 1_500,
    about: "Who the user is and how they like to work",
  },
  workspace: {
    title: "Workspace",
    limit: 4_000,
    about: "Project facts, decisions, and lessons",
  },
} as const;
export type MemoryScope = keyof typeof memoryScopes;
export const memoryEntryMaxChars = 400;

export const memoryScopeSchema = Type.Union([
  Type.Literal("user"),
  Type.Literal("workspace"),
]);
export const memoryChangeSchema = Type.Union([
  Type.Object({
    type: Type.Literal("add"),
    scope: memoryScopeSchema,
    text: Type.String({ minLength: 1, maxLength: memoryEntryMaxChars }),
  }),
  Type.Object({
    type: Type.Literal("edit"),
    id: Type.String({ minLength: 1 }),
    find: Type.String({ minLength: 1 }),
    replace: Type.String(),
  }),
  Type.Object({
    type: Type.Literal("remove"),
    id: Type.String({ minLength: 1 }),
  }),
]);
export type MemoryChange = Static<typeof memoryChangeSchema>;
export const memoryUpdateSchema = Type.Object({
  changes: Type.Array(memoryChangeSchema, { minItems: 1, maxItems: 20 }),
});
export type MemoryUpdate = Static<typeof memoryUpdateSchema>;

export type MemoryEntry = WorkspaceSchema["memories"];
export type MemoryUsage = Record<MemoryScope, { used: number; limit: number }>;
