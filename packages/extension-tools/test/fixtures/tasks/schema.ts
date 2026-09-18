import {
  collection,
  defineRelations,
  defineSchema,
  t,
} from "@get-halo/extension-sdk/schema";

export const schema = defineSchema({
  projects: collection({ id: t.id(), name: t.string() }),
  tasks: collection({
    id: t.id(),
    projectId: t.string(),
    label: t.string(),
    done: t.boolean(),
  }),
});

export const relations = defineRelations(schema, ({ one, many }) => ({
  projects: {
    tasks: many("tasks", { from: "id", to: "projectId" }),
  },
  tasks: {
    project: one("projects", { from: "projectId", to: "id" }),
  },
}));
