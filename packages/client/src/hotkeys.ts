import { Type, type Static } from "@sinclair/typebox";
import * as errore from "errore";

export const hotkeyActionSchema = Type.Union([
  Type.Object({ type: Type.Literal("newTab") }),
  Type.Object({ type: Type.Literal("newChat") }),
  Type.Object({ type: Type.Literal("closeTab") }),
  Type.Object({ type: Type.Literal("shortcutMenu") }),
  Type.Object({
    type: Type.Literal("openFile"),
    path: Type.String({ minLength: 1 }),
  }),
  Type.Object({
    type: Type.Literal("openExtension"),
    id: Type.String({ minLength: 1 }),
  }),
]);
export type HotkeyAction = Static<typeof hotkeyActionSchema>;
export const hotkeyInputSchema = Type.Object({
  id: Type.Optional(Type.String({ minLength: 1 })),
  label: Type.String({ minLength: 1, maxLength: 80 }),
  accelerator: Type.String({ minLength: 1, maxLength: 80 }),
  action: hotkeyActionSchema,
});
export type HotkeyInput = Static<typeof hotkeyInputSchema>;
export type Hotkey = HotkeyInput & { id: string };
export const hotkeySchema = Type.Composite([
  hotkeyInputSchema,
  Type.Object({ id: Type.String({ minLength: 1 }) }),
]);

export class InvalidHotkeyError extends errore.createTaggedError({
  name: "InvalidHotkeyError",
  message: "$reason",
}) {}

// Keep app, editing, and window controls available when a custom shortcut is active.
const reservedAccelerators = new Set([
  "CmdOrCtrl+T",
  "CmdOrCtrl+N",
  "CmdOrCtrl+P",
  "CmdOrCtrl+A",
  "CmdOrCtrl+C",
  "CmdOrCtrl+V",
  "CmdOrCtrl+X",
  "CmdOrCtrl+Z",
  "CmdOrCtrl+Shift+Z",
  "CmdOrCtrl+Y",
  "CmdOrCtrl+W",
  "CmdOrCtrl+Q",
  "CmdOrCtrl+R",
  "CmdOrCtrl+Shift+R",
  "CmdOrCtrl+H",
  "CmdOrCtrl+M",
  "CmdOrCtrl+Alt+H",
  "CmdOrCtrl+Shift+I",
  "CmdOrCtrl+Alt+I",
  "CmdOrCtrl+Alt+J",
  "CmdOrCtrl+Alt+C",
  "CmdOrCtrl+F",
  "CmdOrCtrl+B",
  "CmdOrCtrl+I",
  "CmdOrCtrl+U",
  "CmdOrCtrl+0",
  "CmdOrCtrl+Alt+F",
  "CmdOrCtrl+Shift+3",
  "CmdOrCtrl+Shift+4",
  "CmdOrCtrl+Shift+5",
  "CmdOrCtrl+Shift+6",
]);

export function normalizeHotkey(accelerator: string) {
  const parts = accelerator
    .toLowerCase()
    .split("+")
    .map((part) => part.trim());
  const key = parts.pop();
  if (key === undefined || !/^[a-z0-9]$/.test(key)) {
    return new InvalidHotkeyError({
      reason: "Use a letter or digit as the hotkey key.",
    });
  }
  const modifiers = parts.map((part) => {
    if (
      [
        "cmdorctrl",
        "commandorcontrol",
        "cmd",
        "command",
        "ctrl",
        "control",
        "meta",
        "mod",
      ].includes(part)
    )
      return "CmdOrCtrl";
    if (part === "shift") return "Shift";
    if (part === "alt" || part === "option") return "Alt";
    return undefined;
  });
  if (
    modifiers.includes(undefined) ||
    !modifiers.includes("CmdOrCtrl") ||
    new Set(modifiers).size !== modifiers.length
  ) {
    return new InvalidHotkeyError({
      reason:
        "Use CmdOrCtrl plus optional Shift and Alt, followed by a letter or digit (for example CmdOrCtrl+Shift+K).",
    });
  }
  const normalized = [
    "CmdOrCtrl",
    ...(modifiers.includes("Shift") ? ["Shift"] : []),
    ...(modifiers.includes("Alt") ? ["Alt"] : []),
    key.toUpperCase(),
  ].join("+");
  if (reservedAccelerators.has(normalized)) {
    return new InvalidHotkeyError({
      reason: `${normalized} is reserved by the app. Choose a different combination.`,
    });
  }
  return normalized;
}

export function matchesHotkey(input: {
  accelerator: string;
  key: string;
  code: string;
  meta: boolean;
  control: boolean;
  shift: boolean;
  alt: boolean;
  isMac: boolean;
}) {
  const parts = input.accelerator.split("+");
  const key = parts.at(-1)!;
  // Option changes letters on macOS and Shift changes digits into punctuation.
  const pressed =
    input.alt || /^[0-9]$/.test(key)
      ? input.code.replace(/^(Key|Digit)/, "")
      : input.key.toUpperCase();
  return (
    (input.isMac
      ? input.meta && !input.control
      : input.control && !input.meta) &&
    input.shift === parts.includes("Shift") &&
    input.alt === parts.includes("Alt") &&
    pressed === key
  );
}
