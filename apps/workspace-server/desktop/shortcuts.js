// Keys name the host gesture; chords name the keys sent to the Linux desktop.
const application = {
  a: { chord: ["ControlLeft", "KeyA"] },
  c: { chord: ["ControlLeft", "KeyC"], clipboard: "copy" },
  x: { chord: ["ControlLeft", "KeyX"], clipboard: "copy" },
  v: { chord: ["ControlLeft", "KeyV"], clipboard: "paste" },
  "Shift+v": {
    chord: ["ControlLeft", "ShiftLeft", "KeyV"],
    clipboard: "paste",
  },
  z: { chord: ["ControlLeft", "KeyZ"] },
  "Shift+z": { chord: ["ControlLeft", "ShiftLeft", "KeyZ"] },
  y: { chord: ["ControlLeft", "KeyY"] },
  s: { chord: ["ControlLeft", "KeyS"] },
  "Shift+s": { chord: ["ControlLeft", "ShiftLeft", "KeyS"] },
  f: { chord: ["ControlLeft", "KeyF"] },
  "Shift+f": { chord: ["ControlLeft", "ShiftLeft", "KeyF"] },
  n: { chord: ["ControlLeft", "KeyN"] },
  "Shift+n": { chord: ["ControlLeft", "ShiftLeft", "KeyN"] },
  t: { chord: ["ControlLeft", "KeyT"] },
  "Shift+t": { chord: ["ControlLeft", "ShiftLeft", "KeyT"] },
  w: { chord: ["ControlLeft", "KeyW"] },
  p: { chord: ["ControlLeft", "KeyP"] },
  l: { chord: ["ControlLeft", "KeyL"] },
  r: { chord: ["ControlLeft", "KeyR"] },
  "Shift+r": { chord: ["ControlLeft", "ShiftLeft", "KeyR"] },
  0: { chord: ["ControlLeft", "Digit0"] },
  "-": { chord: ["ControlLeft", "Minus"] },
  "=": { chord: ["ControlLeft", "Equal"] },
  "Shift++": { chord: ["ControlLeft", "Equal"] },
};

const macNavigation = {
  arrowleft: { chord: ["Home"] },
  arrowright: { chord: ["End"] },
  arrowup: { chord: ["ControlLeft", "Home"] },
  arrowdown: { chord: ["ControlLeft", "End"] },
  "Shift+arrowleft": { chord: ["ShiftLeft", "Home"] },
  "Shift+arrowright": { chord: ["ShiftLeft", "End"] },
  "Shift+arrowup": { chord: ["ControlLeft", "ShiftLeft", "Home"] },
  "Shift+arrowdown": { chord: ["ControlLeft", "ShiftLeft", "End"] },
};

export function getShortcut({ event, isMac }) {
  if (event.altKey || event.getModifierState("AltGraph")) return;
  const primary = isMac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!primary) return;
  const key = `${event.shiftKey ? "Shift+" : ""}${event.key.toLowerCase()}`;
  return (isMac ? macNavigation[key] : undefined) ?? application[key];
}

export const pasteShortcut = application.v;
