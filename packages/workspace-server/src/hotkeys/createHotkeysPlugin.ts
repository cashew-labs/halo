import { Type } from "@sinclair/typebox";
import { hotkeyInputSchema } from "@get-halo/client";
import {
  defineHaloTool,
  type HaloToolPlugin,
} from "../agent/tools/HaloToolPlugin.js";
import type { HotkeyService } from "./HotkeyService.js";

export function createHotkeysPlugin(hotkeys: HotkeyService): HaloToolPlugin {
  return {
    id: "hotkeys",
    name: "Keyboard shortcuts",
    tools: [
      defineHaloTool({
        name: "list",
        description:
          "List the user's saved Halo hotkeys and their IDs. Built-in shortcuts are CmdOrCtrl+T (new chat tab), CmdOrCtrl+N (replace current tab with a new chat), and CmdOrCtrl+P (show shortcuts). Custom hotkeys work while Halo is focused and persist in this workspace.",
        inputSchema: Type.Object({}),
        requiredCapabilities: ["workspace.hotkeys"],
        execute: async () => ({ value: hotkeys.list() }),
      }),
      defineHaloTool({
        name: "save",
        description:
          "Create or update a personal keyboard shortcut in Halo. Omit id to create; use an ID from hotkeys.list to update. Use CmdOrCtrl plus optional Shift and Alt and a letter or digit, e.g. CmdOrCtrl+Shift+K. Actions: newTab (fresh chat in a new tab), newChat (replace current tab), closeTab, shortcutMenu, openFile (workspace-relative path in a new tab), openExtension (extension id in a new tab). Changes appear immediately in the user's shortcuts menu. Reserved or conflicting combinations are rejected. Do not claim unsupported actions or OS-wide shortcuts.",
        inputSchema: hotkeyInputSchema,
        requiredCapabilities: ["workspace.hotkeys"],
        execute: async (input) => {
          const saved = await hotkeys.save(input);
          if (saved instanceof Error) return saved;
          return { value: saved };
        },
      }),
      defineHaloTool({
        name: "remove",
        description:
          "Remove a saved Halo hotkey by ID. Its key combination becomes available again immediately.",
        inputSchema: Type.Object({ id: Type.String({ minLength: 1 }) }),
        requiredCapabilities: ["workspace.hotkeys"],
        execute: async ({ id }) => {
          const removed = await hotkeys.remove(id);
          if (removed instanceof Error) return removed;
          return { value: { removed: id } };
        },
      }),
    ],
  };
}
