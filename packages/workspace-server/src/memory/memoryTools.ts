import { Type } from "@sinclair/typebox";
import { memoryScopeSchema, memoryUpdateSchema } from "@get-halo/client";
import { haloTool } from "../agent/tools/HaloTool.js";

export const memoryTools = {
  list: haloTool({
    description:
      "List the current memory entries and how full each scope is. The <memory> section shows the copy from when this thread started; this shows changes other threads have made since.",
    inputSchema: Type.Object({ scope: Type.Optional(memoryScopeSchema) }),
    requiredCapabilities: ["workspace.memory"],
    execute: async (input, context) => {
      const listed = await context.services.memory.list(input);
      if (listed instanceof Error) return listed;
      return { result: listed };
    },
  }),
  update: haloTool({
    description:
      'Add, edit, or remove memory entries in one batch that applies in full or not at all. Scopes: "user" for who the user is and how they like to work (1,500 characters), "workspace" for project facts, decisions, and lessons (4,000 characters). Each entry is one fact of at most 400 characters. An edit replaces the text in find, which must appear exactly once in the entry; to rewrite a whole entry, set find to its full current text. Adding an entry that already exists returns its ID and changes nothing. If a scope would go over its limit, the call fails and lists the current entries: remove or merge entries in the same batch and retry. If an edit fails because another thread changed the entry, the error shows its current text: retry against that.',
    inputSchema: memoryUpdateSchema,
    requiredCapabilities: ["workspace.memory"],
    execute: async ({ changes }, context) => {
      const updated = await context.services.memory.update({
        changes,
        threadId: context.threadId,
      });
      if (updated instanceof Error) return updated;
      return { result: updated };
    },
  }),
};
