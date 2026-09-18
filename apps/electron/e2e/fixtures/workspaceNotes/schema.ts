import { defineRelations, defineSchema } from "@get-halo/extension-sdk/schema";

// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this entry from the scaffolded test package.
export const schema = defineSchema({});
// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this entry from the scaffolded test package.
export const relations = defineRelations(schema, () => ({}));
