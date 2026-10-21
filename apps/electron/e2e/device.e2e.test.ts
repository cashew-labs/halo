import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { e2eTest } from "./e2eTest.js";

type PromptLog = typeof globalThis & { haloAccessPrompts?: string[] };

e2eTest(
  "the agent reads a file on this computer after the person allows it",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    const notes = path.join(harness.paths.root, "Notes");
    const groceries = path.join(notes, "groceries.md");
    await fs.mkdir(notes, { recursive: true });
    await fs.writeFile(groceries, "Buy oat milk\n");
    // Native message boxes cannot be clicked; answer "Allow read only".
    await app.electron.evaluate(({ dialog }) => {
      // SAFETY: The test owns this global in Electron main.
      const log = globalThis as PromptLog;
      log.haloAccessPrompts = [];
      dialog.showMessageBox = async (...args: unknown[]) => {
        // SAFETY: Halo always passes message box options last.
        const options = args.at(-1) as Electron.MessageBoxOptions;
        log.haloAccessPrompts?.push(options.message);
        return await Promise.resolve({ response: 1, checkboxChecked: false });
      };
    });

    // The computer Halo runs on is available without any setup.
    await app.page.getByTestId("account-button").click();
    const settings = app.page
      .getByRole("dialog", { name: "Account" })
      .getByRole("region", { name: "This computer" });
    await expect(settings.getByRole("status")).toContainText("Connected.");
    await expect(
      settings.getByRole("list", { name: "Allowed folders" }),
    ).not.toBeVisible();
    await app.page.keyboard.press("Escape");

    await harness.loadSession({
      title: "Groceries",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Groceries" });
    await pane
      .getByLabel("Message", { exact: true })
      .fill("What is on my grocery list?");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", {
        id: "read-groceries",
        arguments: {
          js: `var computer = (await tools.devices.list()).data.devices[0];
await tools.devices.files.read({ device: computer.name, path: ${JSON.stringify(groceries)} })`,
        },
      }),
    );
    await llm.respond(({ messages }) =>
      m.assistant(
        messageText(messages.at(-1)!).includes("Buy oat milk")
          ? "Your list says to buy oat milk."
          : "I could not read your list.",
      ),
    );
    await expect(pane).toContainText("Your list says to buy oat milk.");
    expect(
      await app.electron.evaluate(
        // SAFETY: Set by the stub above.
        () => (globalThis as PromptLog).haloAccessPrompts,
      ),
    ).toEqual([
      `Allow Halo to read files in ~/${path.relative(os.homedir(), notes)}?`,
    ]);

    // The answer is remembered and shown in settings.
    await app.page.getByTestId("account-button").click();
    const allowed = settings.getByRole("list", { name: "Allowed folders" });
    await expect(allowed.getByRole("listitem")).toHaveText([
      `${notes}Read onlyRemove`,
    ]);

    // Turning the computer off disconnects it from the workspace.
    // The switch input is visually hidden inside its label.
    await settings.getByText(/^Let Halo use /).click();
    await expect(settings.getByRole("status")).toHaveText(
      "The workspace agent cannot use this computer.",
    );
    await expect
      .poll(
        async () =>
          await app.server.rpc.testApi.invokeTool({
            path: "devices.list",
            input: {},
          }),
      )
      .toMatchObject({ devices: [{ online: false }] });
  },
);
