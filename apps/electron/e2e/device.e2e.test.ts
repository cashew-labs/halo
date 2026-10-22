import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { messageText } from "@get-halo/workspace-server/testing";
import { e2eTest } from "./e2eTest.js";

/** How the card shows a path on this computer. */
function display(target: string) {
  return `~/${path.relative(os.homedir(), target)}`;
}

e2eTest(
  "the agent reads a file on this computer after the person allows it in the chat",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    const notes = path.join(harness.paths.root, "Notes");
    const groceries = path.join(notes, "groceries.md");
    await fs.mkdir(notes, { recursive: true });
    await fs.writeFile(groceries, "Buy oat milk\n");
    const read = `var computer = (await tools.devices.list()).data.devices[0];
await tools.devices.files.read({ device: computer.name, path: ${JSON.stringify(groceries)} })`;

    // No settings to set up: the account dialog has no device section.
    await app.page.getByTestId("account-button").click();
    await expect(
      app.page.getByRole("dialog", { name: "Account" }),
    ).toBeVisible();
    await expect(app.page.getByText("This computer")).not.toBeVisible();
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
      m.tool.start("exec", { id: "read-groceries", arguments: { js: read } }),
    );
    await llm.respond(m.assistant("Please allow access to that folder."));

    const card = pane.getByRole("region", {
      name: `Allow Halo to read files in ${display(notes)}?`,
    });
    await expect(card).toContainText(
      `The agent asked to read ${display(groceries)}`,
    );
    await card.getByRole("button", { name: "Allow read only" }).click();
    await expect(card.getByRole("status")).toHaveText("Allowed");

    // The approval notifies the agent, which retries the same read.
    await llm.respond(
      m.tool.start("exec", { id: "read-retry", arguments: { js: read } }),
    );
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

e2eTest(
  "the agent runs a command on this computer after the person allows it in the chat",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    const run = `var computer = (await tools.devices.list()).data.devices[0];
await tools.devices.shell.run({ device: computer.name, command: "echo user=$(id -un)" })`;
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
      m.tool.start("exec", { id: "whoami", arguments: { js: run } }),
    );
    await llm.respond(m.assistant("Please allow commands."));

    const card = pane.getByTestId("device-permission-card");
    await expect(card).toContainText("Allow Halo to run commands on");
    await expect(card).toContainText("echo user=$(id -un)");
    await card.getByRole("button", { name: "Allow commands" }).click();
    await expect(card.getByRole("status")).toHaveText("Allowed");

    await llm.respond(
      m.tool.start("exec", { id: "whoami-retry", arguments: { js: run } }),
    );
    const user = os.userInfo().username;
    await llm.respond(({ messages }) =>
      m.assistant(
        messageText(messages.at(-1)!).includes(`user=${user}`)
          ? `You are ${user}.`
          : "I could not run the command.",
      ),
    );
    await expect(pane).toContainText(`You are ${user}.`);
  },
);

e2eTest(
  "denying in the chat tells the agent not to retry",
  async ({ app, harness, llm }) => {
    e2eTest.setTimeout(90_000);
    await harness.loadSession({
      title: "Private",
      messages: [m.user("Hello"), m.assistant("Ready.")],
    });
    const pane = app.page.getByRole("main", { name: "Private" });
    await pane
      .getByLabel("Message", { exact: true })
      .fill("What is in my home folder?");
    await pane.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", {
        id: "list-home",
        arguments: {
          js: `var computer = (await tools.devices.list()).data.devices[0];
await tools.devices.files.list({ device: computer.name, path: "~" })`,
        },
      }),
    );
    await llm.respond(m.assistant("Please allow access to your home folder."));
    const card = pane.getByRole("region", {
      name: "Allow Halo to read files in your home folder?",
    });
    await card.getByRole("button", { name: "Don't allow" }).click();
    await expect(card.getByRole("status")).toHaveText("Not allowed");
    await llm.respond(({ messages }) =>
      m.assistant(
        messageText(messages.at(-1)!).includes("Do not retry")
          ? "Okay, I won't look in your home folder."
          : "Unexpected.",
      ),
    );
    await expect(pane).toContainText("Okay, I won't look in your home folder.");
  },
);
