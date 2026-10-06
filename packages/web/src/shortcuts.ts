export const shortcuts = {
  newTab: { label: "New chat tab", key: "T", accelerator: "CmdOrCtrl+T" },
  newChat: { label: "New chat", key: "N", accelerator: "CmdOrCtrl+N" },
  closeTab: { label: "Close tab", key: "W", accelerator: "CmdOrCtrl+W" },
  shortcutMenu: {
    label: "Keyboard shortcuts",
    key: "P",
    accelerator: "CmdOrCtrl+P",
  },
  findInTab: { label: "Find in tab", key: "F", accelerator: "CmdOrCtrl+F" },
  findInWorkspace: {
    label: "Find in workspace",
    key: "Shift+F",
    accelerator: "CmdOrCtrl+Shift+F",
  },
} as const;

export type ShortcutId = keyof typeof shortcuts | `custom:${string}`;
