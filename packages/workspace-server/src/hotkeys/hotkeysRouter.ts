import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { HotkeyService } from "./HotkeyService.js";

export type HotkeysRouterContext = { hotkeys: HotkeyService };
const os = implement(contract.hotkeys).$context<HotkeysRouterContext>();
export const hotkeysRouter = os.router({
  list: os.list.handler(({ context }) => context.hotkeys.list()),
  watch: os.watch.handler(({ context, signal }) =>
    context.hotkeys.watch(signal),
  ),
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
