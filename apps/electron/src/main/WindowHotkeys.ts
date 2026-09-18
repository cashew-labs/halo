import type { BrowserWindow } from "electron";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import {
  hotkeySchema,
  matchesHotkey,
  normalizeHotkey,
  type Hotkey,
} from "@get-halo/client";
import {
  CUSTOM_SHORTCUTS_CHANNEL,
  SHORTCUT_CHANNEL,
} from "../shared/shortcuts.js";

export class WindowHotkeys {
  // Each window owns its bindings; a reload clears them until the renderer reconnects.
  private hotkeys: Hotkey[] = [];

  attach(window: BrowserWindow) {
    window.webContents.ipc.on(
      CUSTOM_SHORTCUTS_CHANNEL,
      // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Renderer IPC is parsed at this boundary.
      (event, input: unknown) => {
        if (event.senderFrame !== window.webContents.mainFrame) return;
        if (!Value.Check(Type.Array(hotkeySchema, { maxItems: 50 }), input))
          return;
        if (
          input.some(
            (hotkey) =>
              normalizeHotkey(hotkey.accelerator) !== hotkey.accelerator,
          )
        )
          return;
        this.hotkeys = input;
      },
    );
    window.webContents.on(
      "did-start-navigation",
      (_event, _url, isInPlace, isMainFrame) => {
        if (isMainFrame && !isInPlace) this.hotkeys = [];
      },
    );
    window.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || input.isComposing) return;
      const hotkey = this.hotkeys.find((item) =>
        matchesHotkey({
          accelerator: item.accelerator,
          ...input,
          isMac: process.platform === "darwin",
        }),
      );
      if (hotkey === undefined) return;
      event.preventDefault();
      if (!input.isAutoRepeat)
        window.webContents.send(SHORTCUT_CHANNEL, `custom:${hotkey.id}`);
    });
  }
}
