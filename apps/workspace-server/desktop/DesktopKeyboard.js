import KeyTable from "./core/input/keysym.js";
import { pasteShortcut, getShortcut } from "./shortcuts.js";

const modifiers = {
  ControlLeft: KeyTable.XK_Control_L,
  ControlRight: KeyTable.XK_Control_R,
  ShiftLeft: KeyTable.XK_Shift_L,
  ShiftRight: KeyTable.XK_Shift_R,
  AltLeft: KeyTable.XK_Alt_L,
  AltRight: KeyTable.XK_Alt_R,
  MetaLeft: KeyTable.XK_Super_L,
  MetaRight: KeyTable.XK_Super_R,
};

// noVNC treats macOS Option as AltGraph rather than Linux Alt.
const macModifiers = {
  ...modifiers,
  AltLeft: KeyTable.XK_Mode_switch,
  AltRight: KeyTable.XK_ISO_Level3_Shift,
};

const keysyms = {
  ...modifiers,
  Home: KeyTable.XK_Home,
  End: KeyTable.XK_End,
  Digit0: 0x30,
  Minus: 0x2d,
  Equal: 0x3d,
};

export class DesktopKeyboard {
  // noVNC owns ordinary typing. Only translated chords and clipboard gestures
  // are intercepted; keep its held modifiers intact around each remote chord.
  heldModifiers = new Map();
  consumedKeys = new Set();
  events = new AbortController();
  focusVersion = 0;
  pendingCopy = false;
  isMac = navigator.platform.startsWith("Mac");
  modifierKeysyms = this.isMac ? macModifiers : modifiers;

  constructor({ connection, target, onRelease, onStatus }) {
    this.connection = connection;
    this.target = target;
    this.onRelease = onRelease;
    this.onStatus = onStatus;
    const options = { capture: true, signal: this.events.signal };
    target.addEventListener("keydown", this.keyDown, options);
    target.addEventListener("keyup", this.keyUp, options);
    target.addEventListener("paste", this.nativePaste, options);
    target.addEventListener("pointerdown", this.cancelClipboard, options);
    target.addEventListener("focusout", this.release, options);
    window.addEventListener("blur", this.release, options);
    connection.addEventListener("clipboard", this.copyToHost);
  }

  get focused() {
    return (
      !this.events.signal.aborted &&
      document.hasFocus() &&
      this.target.contains(document.activeElement)
    );
  }

  keyDown = async (event) => {
    if (event.isComposing) return;
    if (
      event.code === "Escape" &&
      event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      !event.metaKey
    ) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.release();
      this.onRelease();
      return;
    }
    // Command is a host modifier, not noVNC's remote Alt/Super. Never send it.
    if (this.isMac && event.key === "Meta") {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }
    const modifier = this.modifierKeysyms[event.code];
    if (modifier !== undefined) {
      const keysym =
        event.key === "AltGraph" ? KeyTable.XK_ISO_Level3_Shift : modifier;
      this.heldModifiers.set(event.code, keysym);
      return;
    }
    this.pendingCopy = false;
    const shortcut = getShortcut({
      event,
      isMac: this.isMac,
    });
    if (shortcut === undefined && !(this.isMac && event.metaKey)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.consumedKeys.add(event.code);
    if (shortcut === undefined || (event.repeat && shortcut.clipboard)) return;
    this.onStatus("");
    if (shortcut.clipboard === "paste") {
      await this.pasteFromHost(shortcut);
      return;
    }
    this.pendingCopy = shortcut.clipboard === "copy";
    this.sendChord(shortcut.chord);
  };

  keyUp = (event) => {
    this.heldModifiers.delete(event.code);
    const consumed = this.consumedKeys.delete(event.code);
    const commandReleased = this.isMac && event.key === "Meta";
    // macOS can omit keyup for keys pressed with Command. Do not swallow a
    // later ordinary keyup and leave that key held in the remote application.
    if (commandReleased) this.consumedKeys.clear();
    if (consumed || commandReleased) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };

  sendChord(chord) {
    for (const [code, keysym] of this.heldModifiers)
      this.connection.sendKey(keysym, code, false);
    for (const code of chord) this.sendKey(code, true);
    for (const code of chord.toReversed()) this.sendKey(code, false);
    for (const [code, keysym] of this.heldModifiers)
      this.connection.sendKey(keysym, code, true);
  }

  sendKey(code, down) {
    const keysym = code.startsWith("Key")
      ? code.slice(3).toLowerCase().codePointAt(0)
      : keysyms[code];
    this.connection.sendKey(keysym, code, down);
  }

  async pasteFromHost(shortcut) {
    const version = this.focusVersion;
    const text = await navigator.clipboard
      .readText()
      .catch(
        (cause) => new Error("Could not read the host clipboard", { cause }),
      );
    // Permission prompts can outlive the connection or the focused application.
    if (!this.focused || version !== this.focusVersion) return;
    if (text instanceof Error) {
      this.clipboardError(text);
      return;
    }
    this.pasteText(text, shortcut);
  }

  nativePaste = (event) => {
    if (!event.clipboardData?.types.includes("text/plain")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    this.pasteText(event.clipboardData.getData("text/plain"), pasteShortcut);
  };

  pasteText(text, shortcut) {
    this.pendingCopy = false;
    this.connection.clipboardPasteFrom(text);
    this.sendChord(shortcut.chord);
    this.onStatus("");
  }

  copyToHost = async (event) => {
    // Do not replace the user's clipboard with initial server state or mere
    // selection changes. Only an explicit copy/cut requests a host write.
    if (!this.focused || !this.pendingCopy) return;
    this.pendingCopy = false;
    const result = await navigator.clipboard
      .writeText(event.detail.text)
      .catch(
        (cause) => new Error("Could not write the host clipboard", { cause }),
      );
    if (result instanceof Error) this.clipboardError(result);
  };

  clipboardError(error) {
    console.warn(error);
    this.onStatus("Clipboard unavailable. Allow clipboard access, then retry.");
  }

  cancelClipboard = () => {
    this.pendingCopy = false;
    this.focusVersion++;
  };

  release = () => {
    for (const [code, keysym] of this.heldModifiers)
      this.connection.sendKey(keysym, code, false);
    this.heldModifiers.clear();
    this.consumedKeys.clear();
    this.cancelClipboard();
  };

  dispose() {
    this.release();
    this.events.abort();
    // noVNC's event emitter does not support AbortSignal listener cleanup.
    this.connection.removeEventListener("clipboard", this.copyToHost);
  }
}
