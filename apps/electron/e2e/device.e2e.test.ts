import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "the agent reads a file on this computer after the person allows it",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    const notes = path.join(harness.paths.root, "Notes");
    const groceries = path.join(notes, "groceries.md");
    await fs.mkdir(notes, { recursive: true });
    await fs.writeFile(groceries, "Buy oat milk\n");
    await app.page.getByTestId("account-button").click();
    await expect(
      app.page.getByRole("region", { name: "This computer" }),
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
    const card = pane.getByRole("region", { name: "Folder access permission" });
    await expect(card).toContainText(notes);
    await card
      .getByRole("button", { name: "Allow read only", exact: true })
      .click();
    await llm.respond(({ messages }) =>
      m.assistant(
        messageText(messages.at(-1)!).includes("Buy oat milk")
          ? "Your list says to buy oat milk."
          : "I could not read your list.",
      ),
    );
    await expect(pane).toContainText("Your list says to buy oat milk.");
    await expect(card.getByRole("status")).toHaveText("Read only");
    await card.getByRole("button", { name: "Remove access" }).click();
    await expect(card.getByRole("status")).toHaveText("Access removed");
  },
);

e2eTest(
  "the agent runs a command on this computer after the person allows it",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    await harness.loadSession({
      title: "Machine",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Machine" });
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Which user am I on my computer?");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", {
        id: "whoami",
        arguments: {
          js: `var computer = (await tools.devices.list()).data.devices[0];
await tools.devices.shell.run({ device: computer.name, command: "echo user=$(id -un)" })`,
        },
      }),
    );
    const card = pane.getByRole("region", { name: "Run commands permission" });
    await expect(card).toContainText("echo user=$(id -un)");
    await expect(card).toContainText(
      "Commands run as you, with your full access",
    );
    await card
      .getByRole("button", { name: "Allow commands", exact: true })
      .click();
    await llm.respond(({ messages }) =>
      m.assistant(
        messageText(messages.at(-1)!).includes(`user=${os.userInfo().username}`)
          ? `You are ${os.userInfo().username}.`
          : "I could not run the command.",
      ),
    );
    await expect(pane).toContainText(`You are ${os.userInfo().username}.`);
    await expect(card.getByRole("status")).toHaveText("Commands allowed");
    await card.getByRole("button", { name: "Remove access" }).click();
    await expect(card.getByRole("status")).toHaveText("Access removed");

    await pane.getByLabel("Message", { exact: true }).fill("Check again.");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", {
        id: "whoami-again",
        arguments: {
          js: `var computer = (await tools.devices.list()).data.devices[0];
await tools.devices.shell.run({ device: computer.name, command: "id -un" })`,
        },
      }),
    );
    const again = pane
      .getByRole("region", { name: "Run commands permission" })
      .last();
    await expect(again).toContainText("id -un");
    await again
      .getByRole("button", { name: "Don't allow", exact: true })
      .click();
    await llm.respond(({ messages }) =>
      m.assistant(
        messageText(messages.at(-1)!).includes("access_denied")
          ? "You refused command access."
          : "Unexpected result.",
      ),
    );
    await expect(pane).toContainText("You refused command access.");
    await expect(again.getByRole("status")).toHaveText("Not allowed");
  },
);

e2eTest(
  "stopping a pending folder request cancels its card and lets the person decide later",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    const notes = path.join(harness.paths.root, "Notes");
    await fs.mkdir(notes, { recursive: true });
    await fs.writeFile(path.join(notes, "groceries.md"), "Buy oat milk\n");
    await harness.loadSession({
      title: "Permission cancellation",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", {
      name: "Permission cancellation",
    });
    const read = `var computer = (await tools.devices.list()).data.devices[0];
await tools.devices.files.read({ device: computer.name, path: ${JSON.stringify(path.join(notes, "groceries.md"))} })`;
    await pane.getByLabel("Message", { exact: true }).fill("Read my list.");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", { id: "read-before-stop", arguments: { js: read } }),
    );
    const cards = pane.getByRole("region", {
      name: "Folder access permission",
    });
    await expect(cards).toHaveCount(1);
    await pane.getByRole("button", { name: "Stop", exact: true }).click();
    await expect(cards.first().getByRole("status")).toHaveText("Cancelled");
    await pane
      .getByLabel("Message", { exact: true })
      .fill("Read my list again.");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", { id: "read-after-stop", arguments: { js: read } }),
    );
    await expect(cards).toHaveCount(2);
    await cards
      .last()
      .getByRole("button", { name: "Allow read only", exact: true })
      .click();
    await llm.respond(({ messages }) =>
      m.assistant(
        messageText(messages.at(-1)!).includes("Buy oat milk")
          ? "Your list says to buy oat milk."
          : "I could not read your list.",
      ),
    );
    await expect(pane).toContainText("Your list says to buy oat milk.");
  },
);
