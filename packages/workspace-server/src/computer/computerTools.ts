import { Type, type TObject, type Static } from "@sinclair/typebox";
import { haloTool } from "../agent/tools/HaloTool.js";
import type { ComputerService } from "./ComputerService.js";

const targetId = Type.String({ minLength: 1 });
const index = Type.Integer({ minimum: 0 });
const point = Type.Tuple([Type.Number(), Type.Number()]);
const selector = Type.Union([index, point]);
const targetInput = { targetId };
const browser = Type.String({ minLength: 1 });
const deliveryMode = Type.Union([
  Type.Literal("background"),
  Type.Literal("foreground"),
]);

function computerTool<S extends TObject>(definition: {
  description: string;
  inputSchema: S;
  execute: (
    input: Static<S>,
    context: { service: ComputerService; signal: AbortSignal | undefined },
  ) => Promise<object | void | Error>;
}) {
  return haloTool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    requiredCapabilities: ["workspace.computer"],
    execute: async (input, context) => {
      const result = await definition.execute(input, {
        service: context.services.computer,
        signal: context.signal,
      });
      if (result instanceof Error) return result;
      return { result: result ?? { ok: true } };
    },
  });
}

export const computerTools = {
  listApps: computerTool({
    description:
      "List desktop apps with targetIds, bound lazily on first use. Pass an app ID to getApp to bind immediately. Listing does not launch apps.",
    inputSchema: Type.Object({}),
    execute: async (_, { service, signal }) =>
      await service.listApps({ signal }),
  }),
  getApp: computerTool({
    description:
      "Bind a desktop app by name or app ID. Returns targetId; app scope follows its frontmost window. This does not guarantee foreground activation. After an app restarts, call getApp afresh; retained targetIds never migrate to the replacement process. Ambiguous names refuse.",
    inputSchema: Type.Object({ app: Type.String({ minLength: 1 }) }),
    execute: async (input, { service, signal }) =>
      await service.getApp({ ...input, signal }),
  }),
  listTabs: computerTool({
    description:
      "Discover exact browser tabs and return targetIds with ownership metadata. Discovery requires SDK/driver support.",
    inputSchema: Type.Object({ browser: Type.Optional(browser) }),
    execute: async (input, { service, signal }) =>
      await service.listTabs({ ...input, signal }),
  }),
  getTab: computerTool({
    description:
      "Bind an exact tab ID from listTabs; stale IDs fail without opening a replacement.",
    inputSchema: Type.Object({ id: targetId, browser: Type.Optional(browser) }),
    execute: async (input, { service, signal }) =>
      await service.getTab({ ...input, signal }),
  }),
  createTab: computerTool({
    description:
      "Create an owned browser tab (SDK supports chrome and edge). Omit url for about:blank.",
    inputSchema: Type.Object({ browser, url: Type.Optional(Type.String()) }),
    execute: async (input, { service, signal }) =>
      await service.createTab({ ...input, signal }),
  }),
  observe: computerTool({
    description:
      "Observe AX text, optionally save a screenshot as a workspace-relative image file. If capture is unavailable, AX text remains and screenshotError gives the code, message and recovery suggestion; no screenshot is returned. Log text and call viewImage(result.data.screenshot) in exec when a screenshot is present. Extensions can read screenshot.path. Use fresh indices; coordinate input uses screenshot pixels and requires a fresh valid target screenshot.",
    inputSchema: Type.Object({
      ...targetInput,
      screenshot: Type.Optional(Type.Boolean()),
    }),
    execute: async (input, { service, signal }) =>
      await service.observe({ ...input, signal }),
  }),
  click: computerTool({
    description:
      "Click a fresh element index or screenshot pixel [x,y]. For trusted browser input, set options.deliveryMode to foreground; this may activate the browser and change focus. The default remains background and may refuse coordinates. SDK failures are preserved; observe the actual result.",
    inputSchema: Type.Object({
      ...targetInput,
      target: selector,
      options: Type.Optional(
        Type.Object({
          mouseButton: Type.Optional(
            Type.Union([
              Type.Literal("left"),
              Type.Literal("right"),
              Type.Literal("middle"),
            ]),
          ),
          clickCount: Type.Optional(Type.Integer({ minimum: 1 })),
          deliveryMode: Type.Optional(deliveryMode),
        }),
      ),
    }),
    execute: async (input, { service, signal }) =>
      await service.click({ ...input, signal }),
  }),
  drag: computerTool({
    description: "Drag between screenshot pixel points on this target.",
    inputSchema: Type.Object({ ...targetInput, from: point, to: point }),
    execute: async (input, { service, signal }) =>
      await service.drag({ ...input, signal }),
  }),
  scroll: computerTool({
    description:
      "Scroll at a fresh element index or screenshot pixel point. Set options.deliveryMode to foreground for trusted browser input; this may activate the browser and change focus. The default remains background and may refuse coordinates. Observe the actual result.",
    inputSchema: Type.Object({
      ...targetInput,
      target: selector,
      direction: Type.Union([
        Type.Literal("up"),
        Type.Literal("down"),
        Type.Literal("left"),
        Type.Literal("right"),
      ]),
      pages: Type.Optional(Type.Number({ exclusiveMinimum: 0 })),
      options: Type.Optional(
        Type.Object({ deliveryMode: Type.Optional(deliveryMode) }),
      ),
    }),
    execute: async (input, { service, signal }) =>
      await service.scroll({ ...input, signal }),
  }),
  pressKey: computerTool({
    description:
      "Send an SDK key or key combination. Focus must be established before untargeted keys.",
    inputSchema: Type.Object({
      ...targetInput,
      key: Type.String({ minLength: 1 }),
      elementIndex: Type.Optional(index),
    }),
    execute: async (input, { service, signal }) =>
      await service.pressKey({ ...input, signal }),
  }),
  typeText: computerTool({
    description:
      "Type into the target's focused control; does not establish focus or submit.",
    inputSchema: Type.Object({ ...targetInput, text: Type.String() }),
    execute: async (input, { service, signal }) =>
      await service.typeText({ ...input, signal }),
  }),
  setValue: computerTool({
    description:
      "Replace the value of a fresh element index. Does not guarantee focus or send Enter.",
    inputSchema: Type.Object({
      ...targetInput,
      elementIndex: index,
      value: Type.String(),
    }),
    execute: async (input, { service, signal }) =>
      await service.setValue({ ...input, signal }),
  }),
  paste: computerTool({
    description:
      "Paste through the SDK only. Native X11 plaintext paste brings the bound window forward and leaves the payload on the VM clipboard. Rich formats may be unsupported. A failed paste may have changed text or clipboard; inspect its delivery details and observe before retrying. No automatic typing fallback or replay is supplied.",
    inputSchema: Type.Object({
      ...targetInput,
      text: Type.String(),
      options: Type.Optional(
        Type.Object({
          format: Type.Optional(
            Type.Union([
              Type.Literal("text"),
              Type.Literal("md"),
              Type.Literal("html"),
            ]),
          ),
        }),
      ),
    }),
    execute: async (input, { service, signal }) =>
      await service.paste({ ...input, signal }),
  }),
  goto: computerTool({
    description: "Navigate an exact tab to a URL, then observe separately.",
    inputSchema: Type.Object({
      ...targetInput,
      url: Type.String({ minLength: 1 }),
    }),
    execute: async (input, { service, signal }) =>
      await service.goto({ ...input, signal }),
  }),
  back: computerTool({
    description: "Navigate back in an exact tab.",
    inputSchema: Type.Object(targetInput),
    execute: async (input, { service, signal }) =>
      await service.back({ ...input, signal }),
  }),
  forward: computerTool({
    description: "Navigate forward in an exact tab.",
    inputSchema: Type.Object(targetInput),
    execute: async (input, { service, signal }) =>
      await service.forward({ ...input, signal }),
  }),
  reload: computerTool({
    description: "Reload an exact tab.",
    inputSchema: Type.Object(targetInput),
    execute: async (input, { service, signal }) =>
      await service.reload({ ...input, signal }),
  }),
  close: computerTool({
    description:
      "Close only a tab created by this service. Borrowed tabs and native apps are refused.",
    inputSchema: Type.Object(targetInput),
    execute: async (input, { service, signal }) =>
      await service.close({ ...input, signal }),
  }),
};
