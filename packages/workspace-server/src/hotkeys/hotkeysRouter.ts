import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { HotkeyService } from "./HotkeyService.js";

export type HotkeysRouterContext = { hotkeys: HotkeyService };
const os = implement(contract.hotkeys).$context<HotkeysRouterContext>();
export const hotkeysRouter = os.router({
  list: os.list.handler(async ({ context }) => {
    const hotkeys = await context.hotkeys.list();
    if (hotkeys instanceof Error) return orpcErrors.badRequest(hotkeys);
    return hotkeys;
  }),
  watch: os.watch.handler(async function* ({ context, signal }) {
    for await (const hotkeys of context.hotkeys.watch(signal)) {
      if (hotkeys instanceof Error) throw orpcErrors.badRequest(hotkeys);
      yield hotkeys;
    }
  }),
  save: os.save.handler(async ({ context, input }) => {
    const saved = await context.hotkeys.save(input);
    if (saved instanceof Error) return orpcErrors.badRequest(saved);
    return saved;
  }),
  remove: os.remove.handler(async ({ context, input }) => {
    const removed = await context.hotkeys.remove(input.id);
    if (removed instanceof Error) return orpcErrors.badRequest(removed);
  }),
});
