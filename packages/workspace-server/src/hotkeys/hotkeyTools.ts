import { Type } from "@sinclair/typebox";
import { hotkeyInputSchema } from "@get-halo/client";
import { haloTool } from "../agent/tools/HaloTool.js";

export const hotkeyTools = {
  list: haloTool({
    description:
      "List the user's saved Halo hotkeys and their IDs. Built-in shortcuts are CmdOrCtrl+T (new chat tab), CmdOrCtrl+N (replace current tab with a new chat), and CmdOrCtrl+P (show shortcuts). Custom hotkeys work while Halo is focused and persist in this workspace.",
    inputSchema: Type.Object({}),
    requiredCapabilities: ["workspace.hotkeys"],
    execute: async (_input, ctx) => {
      const listed = await ctx.services.hotkeys.list();
      if (listed instanceof Error) return listed;
      return { result: listed };
    },
  }),
  save: haloTool({
    description:
      "Create or update a personal keyboard shortcut in Halo. Omit id to create; use an ID from hotkeys.list to update. Use CmdOrCtrl plus optional Shift and Alt and a letter or digit, e.g. CmdOrCtrl+Shift+K. For flexible or multi-step tasks, use runAgent with a self-contained prompt: pressing the hotkey starts a fresh chat and immediately sends that instruction to the agent with its normal tools. For example, runAgent with prompt: Create notes/daily.md with an original summary of the workspace Markdown files. Store instructions for what to generate each time, not pre-generated output. The new chat does not inherit this conversation, so include needed paths and context in the prompt. Saving a hotkey does not execute it. Other actions: newTab (fresh chat in a new tab), newChat (replace current tab), closeTab, shortcutMenu, openFile (workspace-relative path in a new tab), openExtension (extension id in a new tab). Changes appear immediately in the user's shortcuts menu. Reserved or conflicting combinations are rejected. Do not claim unsupported actions or OS-wide shortcuts.",
    inputSchema: hotkeyInputSchema,
    requiredCapabilities: ["workspace.hotkeys"],
    execute: async (input, ctx) => {
      const saved = await ctx.services.hotkeys.save(input);
      if (saved instanceof Error) return saved;
      return { result: saved };
    },
  }),
  remove: haloTool({
    description:
      "Remove a saved Halo hotkey by ID. Its key combination becomes available again immediately.",
    inputSchema: Type.Object({ id: Type.String({ minLength: 1 }) }),
    requiredCapabilities: ["workspace.hotkeys"],
    execute: async ({ id }, ctx) => {
      const removed = await ctx.services.hotkeys.remove(id);
      if (removed instanceof Error) return removed;
      return { result: { removed: id } };
    },
  }),
};
