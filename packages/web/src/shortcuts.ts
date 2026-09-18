export const shortcuts = {
  newTab: { label: "New chat tab", key: "T", accelerator: "CmdOrCtrl+T" },
  newChat: { label: "New chat", key: "N", accelerator: "CmdOrCtrl+N" },
  shortcutMenu: {
    label: "Keyboard shortcuts",
    key: "P",
    accelerator: "CmdOrCtrl+P",
  },
} as const;

export type ShortcutId = keyof typeof shortcuts | `custom:${string}`;
