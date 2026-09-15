export const shortcuts = {
  newChat: { label: "New chat", key: "N", accelerator: "CmdOrCtrl+N" },
  shortcutMenu: {
    label: "Keyboard shortcuts",
    key: "P",
    accelerator: "CmdOrCtrl+P",
  },
} as const;

export type ShortcutId = keyof typeof shortcuts;
