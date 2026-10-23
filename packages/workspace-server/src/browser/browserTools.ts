import { Type, type Static, type TObject } from "@sinclair/typebox";
import { haloTool } from "../agent/tools/HaloTool.js";
import {
  BrowserUnavailableError,
  browserArgsSchema,
  browserStepSchema,
  dialogAnswerSchema,
  type BrowserService,
} from "./BrowserService.js";

const pageId = Type.String({ minLength: 1 });

function browserTool<S extends TObject>(definition: {
  description: string;
  inputSchema: S;
  execute: (
    input: Static<S>,
    context: { service: BrowserService; signal: AbortSignal | undefined },
  ) => Promise<object | void | Error>;
}) {
  return haloTool({
    description: definition.description,
    inputSchema: definition.inputSchema,
    requiredCapabilities: ["workspace.browser"],
    execute: async (input, context) => {
      const service = context.services.browser;
      if (service === undefined)
        return new BrowserUnavailableError({
          detail: "this workspace has no Chrome",
        });
      const result = await definition.execute(input, {
        service,
        signal: context.signal,
      });
      if (result instanceof Error) return result;
      return { result: result ?? { ok: true } };
    },
  });
}

export const browserTools = {
  tabs: browserTool({
    description:
      "List the workspace Chrome's open tabs: `{ id, url, title }`. The user's tabs are listed too. Returns `[]` when Chrome is not running.",
    inputSchema: Type.Object({}),
    execute: async (_, { service, signal }) => await service.tabs({ signal }),
  }),
  newPage: browserTool({
    description:
      "Open a tab in the user's workspace Chrome, starting Chrome if needed, and optionally navigate it to `url`. `isolated` opens it in a new incognito-style context without the user's cookies; that context closes with its last tab or if Halo reconnects to Chrome. Returns `{ id, url, title }`.",
    inputSchema: Type.Object({
      url: Type.Optional(Type.String({ minLength: 1 })),
      isolated: Type.Optional(Type.Boolean()),
    }),
    execute: async (input, { service, signal }) =>
      await service.newPage({ ...input, signal }),
  }),
  call: browserTool({
    description: [
      "Run one Playwright `method` with `args` on the tab `page`. `chain` is a list of `[builder, args]` locator steps applied to the page, for example `[['getByRole', ['button', { name: 'Save' }]], ['first', []]]`; an empty `chain` calls a page method.",
      "Page builders: locator, getByRole, getByText, getByLabel, getByPlaceholder, getByAltText, getByTitle, getByTestId; locators also allow filter, first, last, nth, and, or.",
      "Locator methods: click, dblclick, fill, press, pressSequentially, check, uncheck, setChecked, selectOption, hover, focus, clear, setInputFiles (paths in the workspace), scrollIntoViewIfNeeded, waitFor, textContent, innerText, inputValue, getAttribute, isVisible, isHidden, isEnabled, isChecked, count, allInnerTexts, allTextContents, boundingBox, ariaSnapshot, evaluate.",
      "Page methods: goto, reload, goBack, goForward (return `{ url, status }`, or no value when the page loaded without a network response; goBack and goForward resolve once the navigation commits, so wait for a load state or element when needed), title, content, evaluate, waitForURL, waitForLoadState, waitForTimeout, bringToFront, keyboard.press, keyboard.type, snapshot, screenshot.",
      "snapshot returns an AI aria snapshot with `[ref=s1e2]` refs; act on one with `chain` `[['locator', ['aria-ref=s1e2']]]`. Any newer snapshot of the tab invalidates older refs. screenshot saves a PNG to its `path` option, a workspace `.png` path, or else under `.halo/browser/screenshots`, and returns `{ path }` for viewImage.",
      "Encode non-JSON `args`: `{ $regexp, flags }` for a RegExp, `{ $undefined: true }` for a skipped argument, `{ $function: source }` for evaluate's first argument only, and `{ $locator: { page, chain } }` for a locator in builder arguments such as `filter({ has })` or in screenshot's `mask` option.",
      "A dialog that opens during the call is dismissed, or accepted when `dialogs` is `{ action: 'accept', promptText? }`, and listed in the result's `dialogs`. A dialog that opened between calls is always dismissed. Actions time out after 30 seconds and calls after 60 seconds. Returns `{ value, url, dialogs? }`; `value` must be JSON and at most 256 KiB.",
    ].join(" "),
    inputSchema: Type.Object({
      page: pageId,
      chain: Type.Array(browserStepSchema),
      method: Type.String({ minLength: 1 }),
      args: browserArgsSchema,
      dialogs: Type.Optional(dialogAnswerSchema),
    }),
    execute: async (input, { service, signal }) =>
      await service.call({ ...input, signal }),
  }),
  close: browserTool({
    description:
      "Close the tab `page`. Close the tabs you opened when you are done; close the user's tabs only when asked.",
    inputSchema: Type.Object({ page: pageId }),
    execute: async (input, { service, signal }) =>
      await service.close({ ...input, signal }),
  }),
};
