import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import * as errore from "errore";
import {
  createCua,
  createOpenSky,
  CuaTargetClosedError,
  CuaTargetNotFoundError,
  OpenSkyError,
  type CuaFacade,
  type OpenSky,
  type OpenSkyOptions,
  type Target,
  type Tab,
  type Vec2,
  type ClickOptions,
  type Direction,
  type PasteOptions,
  type ScrollOptions,
} from "opensky-cua";

export class ComputerError extends errore.createTaggedError({
  name: "ComputerError",
  message: "Computer operation failed: $detail",
}) {
  constructor(input: { detail: string; cause?: unknown }) {
    super({
      ...input,
      // Tool results expose message, not the cause chain. Preserve driver refusals.
      detail:
        input.cause instanceof Error
          ? `${input.detail}: ${input.cause.message}`
          : input.detail,
    });
  }
}
export class ComputerTargetError extends errore.createTaggedError({
  name: "ComputerTargetError",
  message: "Unknown or stale computer target $targetId",
}) {}
export class ComputerAbortedError extends errore.createTaggedError({
  name: "ComputerAbortedError",
  message: "Computer operation cancelled before dispatch",
  extends: errore.AbortError,
}) {}

type Dispatch = { signal?: AbortSignal };
type TargetInput = Dispatch & { targetId: string };
type BoundTarget = { target: Target; tab?: Tab; owned: boolean };

export class ComputerService {
  // One runtime and exact live bindings belong to the server, not an exec session.
  private runtime?: { sdk: OpenSky; cua: CuaFacade };
  private readonly targets = new Map<string, BoundTarget>();
  private readonly appSelectors = new Map<string, string>();
  private pending: Promise<void> = Promise.resolve();
  private closed = false;
  private readonly workspaceRoot: string;
  private readonly sdkOptions: OpenSkyOptions;

  constructor(ctx: {
    workspaceRoot: string;
    driverOptions?: OpenSkyOptions["driverOptions"];
    target?: OpenSkyOptions["target"];
    transport?: OpenSkyOptions["transport"];
  }) {
    const { workspaceRoot, driverOptions, target, transport } = ctx;
    this.workspaceRoot = workspaceRoot;
    this.sdkOptions = {
      homeDir: path.join(workspaceRoot, ".halo/computer/runtime"),
      driverOptions: { autoStart: false, ...driverOptions },
      target,
      transport,
    };
  }

  private getRuntime() {
    if (this.runtime) return this.runtime;
    const sdk = errore.try({
      try: () => createOpenSky(this.sdkOptions),
      catch: (cause) =>
        new ComputerError({ detail: "initialize OpenSky", cause }),
    });
    if (sdk instanceof Error) return sdk;
    this.runtime = { sdk, cua: createCua(sdk) };
    return this.runtime;
  }

  private async dispatch<T>(
    input: Dispatch,
    operation: () => Promise<T | Error>,
  ): Promise<T | Error> {
    const result = this.pending.then(async () => {
      if (input.signal?.aborted)
        return new ComputerAbortedError({ cause: input.signal.reason });
      if (this.closed)
        return new ComputerError({ detail: "service is shut down" });
      return await operation();
    });
    // Never race against cancellation: hold the queue until the SDK call settles.
    this.pending = result.then(
      () => undefined,
      (cause) => {
        console.error("Unexpected computer operation failure", cause);
      },
    );
    return await result;
  }

  async listApps(input: Dispatch = {}) {
    return await this.dispatch(input, async () => {
      const runtime = this.getRuntime();
      if (runtime instanceof Error) return runtime;
      const apps = await runtime.cua
        .listApps({ emit: false })
        .catch((cause) => new ComputerError({ detail: "list apps", cause }));
      if (apps instanceof Error) return apps;
      // Listing must not launch apps or require every app's AX tree. Bind lazily.
      return apps.map((app) => {
        const targetId =
          [...this.appSelectors].find(
            ([, selector]) => selector === app.id,
          )?.[0] ?? crypto.randomUUID();
        this.appSelectors.set(targetId, app.id);
        return { ...app, targetId };
      });
    });
  }

  async getApp(input: Dispatch & { app: string }) {
    return await this.dispatch(input, async () => {
      const runtime = this.getRuntime();
      if (runtime instanceof Error) return runtime;
      const target = await runtime.cua
        .getApp(input.app)
        .catch((cause) => new ComputerError({ detail: "get app", cause }));
      if (target instanceof Error) return target;
      const targetId = crypto.randomUUID();
      this.targets.set(targetId, { target, owned: false });
      return { targetId };
    });
  }

  async listTabs(input: Dispatch & { browser?: string } = {}) {
    return await this.dispatch(input, async () => {
      const runtime = this.getRuntime();
      if (runtime instanceof Error) return runtime;
      const tabs = await runtime.cua
        .listTabs({ browser: input.browser, emit: false })
        .catch((cause) => new ComputerError({ detail: "list tabs", cause }));
      if (tabs instanceof Error) return tabs;
      for (const info of tabs) {
        if (input.signal?.aborted)
          return new ComputerAbortedError({ cause: input.signal.reason });
        const tab = await runtime.cua
          .getTab(info.id, { browser: info.browserId, emit: false })
          .catch(
            (cause) =>
              new ComputerError({ detail: "bind discovered tab", cause }),
          );
        if (tab instanceof Error) return tab;
        this.targets.set(tab.id, { target: tab, tab, owned: info.owned });
      }
      return tabs.map((tab) => ({ ...tab, targetId: tab.id }));
    });
  }

  async getTab(input: Dispatch & { id: string; browser?: string }) {
    return await this.dispatch(input, async () => {
      const runtime = this.getRuntime();
      if (runtime instanceof Error) return runtime;
      const tab = await runtime.cua
        .getTab(input.id, { browser: input.browser, emit: false })
        .catch((cause) =>
          cause instanceof CuaTargetClosedError ||
          cause instanceof CuaTargetNotFoundError
            ? new ComputerTargetError({ targetId: input.id, cause })
            : new ComputerError({ detail: "get tab", cause }),
        );
      if (tab instanceof Error) return tab;
      const existing = this.targets.get(tab.id);
      this.targets.set(tab.id, {
        target: tab,
        tab,
        owned: existing?.owned ?? false,
      });
      return { targetId: tab.id, browser: tab.browserId };
    });
  }

  async createTab(input: Dispatch & { browser: string; url?: string }) {
    return await this.dispatch(input, async () => {
      const runtime = this.getRuntime();
      if (runtime instanceof Error) return runtime;
      const tab = await runtime.cua
        .createBrowserTab(input.browser, input.url)
        .catch((cause) => new ComputerError({ detail: "create tab", cause }));
      if (tab instanceof Error) return tab;
      this.targets.set(tab.id, { target: tab, tab, owned: true });
      return { targetId: tab.id, browser: tab.browserId };
    });
  }

  private async withTarget<T>(
    input: TargetInput,
    operation: (binding: BoundTarget) => Promise<T | Error>,
  ) {
    return await this.dispatch(input, async () => {
      const binding = this.targets.get(input.targetId);
      if (binding) {
        const result = await operation(binding);
        if (
          result instanceof Error &&
          (errore.findCause(result, CuaTargetClosedError) ||
            errore.findCause(result, CuaTargetNotFoundError))
        ) {
          this.targets.delete(input.targetId);
          this.appSelectors.delete(input.targetId);
          return new ComputerTargetError({
            targetId: input.targetId,
            cause: result,
          });
        }
        return result;
      }
      const app = this.appSelectors.get(input.targetId);
      if (!app) return new ComputerTargetError({ targetId: input.targetId });
      const runtime = this.getRuntime();
      if (runtime instanceof Error) return runtime;
      const target = await runtime.cua
        .getApp(app)
        .catch(
          (cause) => new ComputerError({ detail: "bind listed app", cause }),
        );
      if (target instanceof Error) return target;
      const resolved = { target, owned: false };
      this.targets.set(input.targetId, resolved);
      if (input.signal?.aborted)
        return new ComputerAbortedError({ cause: input.signal.reason });
      return await operation(resolved);
    });
  }

  async observe(input: TargetInput & { screenshot?: boolean }) {
    return await this.withTarget(input, async ({ target }) => {
      if (!input.screenshot) {
        const text = await target
          .getAXState({ emit: false, disableDiffing: true })
          .catch((cause) => new ComputerError({ detail: "observe", cause }));
        if (text instanceof Error) return text;
        return { text };
      }
      const observation = await target
        .getAXStateAndScreenshot({ emit: false, disableDiffing: true })
        .catch(
          (cause) =>
            new ComputerError({ detail: "observe with screenshot", cause }),
        );
      if (observation instanceof Error) return observation;
      if (observation.screenshotError)
        return {
          text: observation.state,
          screenshotError: observation.screenshotError,
        };
      if (!observation.screenshot) return { text: observation.state };
      const bytes = Buffer.from(observation.screenshot);
      const extension = bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "png"
        : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          ? "jpg"
          : undefined;
      if (!extension)
        return new ComputerError({
          detail: "SDK screenshot is not PNG or JPEG",
        });
      const directory = path.join(this.workspaceRoot, ".halo/computer/images");
      const made = await fs
        .mkdir(directory, { recursive: true })
        .catch(
          (cause) =>
            new ComputerError({ detail: "create screenshot directory", cause }),
        );
      if (made instanceof Error) return made;
      const relativePath = `.halo/computer/images/${crypto.randomUUID()}.${extension}`;
      const saved = await fs
        .writeFile(path.join(this.workspaceRoot, relativePath), bytes, {
          flag: "wx",
        })
        .catch(
          (cause) => new ComputerError({ detail: "save screenshot", cause }),
        );
      if (saved instanceof Error) return saved;
      return { text: observation.state, screenshot: { path: relativePath } };
    });
  }

  async click(
    input: TargetInput & { target: number | Vec2; options?: ClickOptions },
  ) {
    return await this.withTarget(
      input,
      async ({ target }) =>
        await target
          .click(input.target, input.options)
          .catch((cause) => new ComputerError({ detail: "click", cause })),
    );
  }
  async drag(input: TargetInput & { from: Vec2; to: Vec2 }) {
    return await this.withTarget(
      input,
      async ({ target }) =>
        await target
          .drag(input.from, input.to)
          .catch((cause) => new ComputerError({ detail: "drag", cause })),
    );
  }
  async scroll(
    input: TargetInput & {
      target: number | Vec2;
      direction: Direction;
      pages?: number;
      options?: ScrollOptions;
    },
  ) {
    return await this.withTarget(
      input,
      async ({ target }) =>
        await target
          .scroll(input.target, input.direction, input.pages, input.options)
          .catch((cause) => new ComputerError({ detail: "scroll", cause })),
    );
  }
  async pressKey(input: TargetInput & { key: string; elementIndex?: number }) {
    return await this.withTarget(
      input,
      async ({ target }) =>
        await target
          .pressKey(input.key, input.elementIndex)
          .catch((cause) => new ComputerError({ detail: "press key", cause })),
    );
  }
  async typeText(input: TargetInput & { text: string }) {
    return await this.withTarget(
      input,
      async ({ target }) =>
        await target
          .typeText(input.text)
          .catch((cause) => new ComputerError({ detail: "type text", cause })),
    );
  }
  async setValue(input: TargetInput & { elementIndex: number; value: string }) {
    return await this.withTarget(
      input,
      async ({ target }) =>
        await target
          .setValue(input.elementIndex, input.value)
          .catch((cause) => new ComputerError({ detail: "set value", cause })),
    );
  }
  async paste(input: TargetInput & { text: string; options?: PasteOptions }) {
    return await this.withTarget(
      input,
      async ({ target }) =>
        await target.paste(input.text, input.options).catch(
          (cause) =>
            new ComputerError({
              // A failed paste may have inserted text; retain the no-replay evidence.
              detail:
                cause instanceof OpenSkyError
                  ? `paste ${JSON.stringify({ code: cause.code, details: cause.details })}`
                  : "paste",
              cause,
            }),
        ),
    );
  }
  async goto(input: TargetInput & { url: string }) {
    return await this.withTarget(input, async ({ tab }) =>
      tab
        ? await tab
            .goto(input.url)
            .catch((cause) => new ComputerError({ detail: "goto", cause }))
        : await Promise.resolve(
            new ComputerError({ detail: "navigation requires a tab" }),
          ),
    );
  }
  async back(input: TargetInput) {
    return await this.withTarget(input, async ({ tab }) =>
      tab
        ? await tab
            .back()
            .catch((cause) => new ComputerError({ detail: "back", cause }))
        : await Promise.resolve(
            new ComputerError({ detail: "navigation requires a tab" }),
          ),
    );
  }
  async forward(input: TargetInput) {
    return await this.withTarget(input, async ({ tab }) =>
      tab
        ? await tab
            .forward()
            .catch((cause) => new ComputerError({ detail: "forward", cause }))
        : await Promise.resolve(
            new ComputerError({ detail: "navigation requires a tab" }),
          ),
    );
  }
  async reload(input: TargetInput) {
    return await this.withTarget(input, async ({ tab }) =>
      tab
        ? await tab
            .reload()
            .catch((cause) => new ComputerError({ detail: "reload", cause }))
        : await Promise.resolve(
            new ComputerError({ detail: "navigation requires a tab" }),
          ),
    );
  }
  async close(input: TargetInput) {
    return await this.withTarget(input, async ({ tab, owned }) => {
      if (!tab || !owned)
        return new ComputerError({
          detail:
            "only service-owned tabs may be closed; borrowed tabs and native apps are not closeable",
        });
      const closed = await tab
        .close()
        .catch((cause) => new ComputerError({ detail: "close tab", cause }));
      if (closed instanceof Error) return closed;
      this.targets.delete(input.targetId);
    });
  }

  async shutdown() {
    this.closed = true;
    const result = this.pending.then(async () => {
      if (!this.runtime) return;
      const closed = await this.runtime.sdk
        .close()
        .catch((cause) => new ComputerError({ detail: "shutdown SDK", cause }));
      if (closed instanceof Error) return closed;
      this.runtime = undefined;
      this.targets.clear();
      this.appSelectors.clear();
    });
    this.pending = result.then(() => undefined);
    return await result;
  }
}
