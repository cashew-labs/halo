import fs from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "the agent reads a file from a folder this computer shares",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    const shared = path.join(harness.paths.root, "Shared notes");
    const groceries = path.join(shared, "groceries.md");
    await fs.mkdir(shared, { recursive: true });
    await fs.writeFile(groceries, "Buy oat milk\n");
    // The native folder picker cannot be driven; return the chosen folder.
    await app.electron.evaluate(({ dialog }, folder) => {
      dialog.showOpenDialog = async () =>
        await Promise.resolve({ canceled: false, filePaths: [folder] });
    }, shared);

    await app.page.getByTestId("account-button").click();
    const settings = app.page
      .getByRole("dialog", { name: "Account" })
      .getByRole("region", { name: "This computer" });
    await expect(settings.getByRole("status")).toHaveText(
      "The workspace agent cannot use this computer.",
    );
    // The switch input is visually hidden inside its label.
    await settings.getByText(/^Let Halo use /).click();
    await expect(
      settings.getByRole("switch", { name: /^Let Halo use / }),
    ).toBeChecked();
    await expect(settings.getByRole("status")).toContainText("Connected.");
    await settings.getByRole("button", { name: "Add folder…" }).click();
    await expect(
      settings.getByRole("button", { name: `Stop sharing ${shared}` }),
    ).toBeVisible();
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

    // Turning the computer off disconnects it from the workspace.
    await app.page.getByTestId("account-button").click();
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
