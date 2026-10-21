import { Type, type Static, type TObject } from "@sinclair/typebox";
import { haloTool } from "../agent/tools/HaloTool.js";
import {
  BrowserUnavailableError,
  browserArgsSchema,
  browserStepSchema,
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
      "List the workspace Chrome's open tabs: { id, url, title, owned }. owned is true for tabs an agent opened. Returns [] when Chrome is not running.",
    inputSchema: Type.Object({}),
    execute: async (_, { service }) => await service.tabs(),
  }),
  newPage: browserTool({
    description:
      "Open a tab in the user's workspace Chrome, starting Chrome if needed, and optionally navigate it. isolated opens it in a new incognito-style context without the user's cookies; isolated tabs close if Halo reconnects to Chrome. Returns { id, url, title }.",
    inputSchema: Type.Object({
      url: Type.Optional(Type.String({ minLength: 1 })),
      isolated: Type.Optional(Type.Boolean()),
    }),
    execute: async (input, { service, signal }) =>
      await service.newPage({ ...input, signal }),
  }),
  call: browserTool({
    description: [
      "Run one Playwright method on a tab. chain is a list of [builder, args] locator steps applied to the page, for example [['getByRole', ['button', { name: 'Save' }]], ['first', []]]; an empty chain calls a page method.",
      "Page builders: locator, getByRole, getByText, getByLabel, getByPlaceholder, getByAltText, getByTitle, getByTestId; locators also allow filter, first, last, nth, and, or.",
      "Locator methods: click, dblclick, fill, press, pressSequentially, check, uncheck, setChecked, selectOption, hover, focus, clear, setInputFiles (workspace-relative paths), scrollIntoViewIfNeeded, waitFor, textContent, innerText, inputValue, getAttribute, isVisible, isHidden, isEnabled, isChecked, count, allInnerTexts, allTextContents, boundingBox, ariaSnapshot, evaluate.",
      "Page methods: goto, reload, goBack, goForward (return { url, status }, or no value when the page loaded without a network response; goBack and goForward resolve once the navigation commits, so wait for a load state or element when needed), title, content, evaluate, waitForURL, waitForLoadState, waitForTimeout, bringToFront, keyboard.press, keyboard.type, snapshot, screenshot.",
      "snapshot returns an AI aria snapshot with [ref=s1e2] refs; act on one with chain [['locator', ['aria-ref=s1e2']]]. A newer snapshot of the tab invalidates older refs. screenshot saves a PNG and returns { path } for files.viewImage.",
      "Encode non-JSON arguments: { $regexp, flags } for a RegExp, { $function: source } for an evaluate function, { $locator: { page, chain } } for a locator argument such as filter({ has }), and { $undefined: true } for a skipped argument.",
      "Actions time out after 30 seconds and calls after 60 seconds. Returns { value, url }; value must be JSON and at most 256 KiB.",
    ].join(" "),
    inputSchema: Type.Object({
      page: pageId,
      chain: Type.Array(browserStepSchema),
      method: Type.String({ minLength: 1 }),
      args: browserArgsSchema,
    }),
    execute: async (input, { service, signal }) =>
      await service.call({ ...input, signal }),
  }),
  close: browserTool({
    description:
      "Close a tab an agent opened. Tabs the user opened are refused.",
    inputSchema: Type.Object({ page: pageId }),
    execute: async (input, { service }) => await service.close(input),
  }),
};
