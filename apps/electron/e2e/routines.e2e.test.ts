import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "lists personal routines and opens their run sessions",
  async ({ app, harness }) => {
    await harness.tools.bash.run({
      command: "mkdir -p .halo/extensions/appointments",
    });
    await app.server.rpc.routines.save({
      extensionId: "appointments",
      name: "Book haircut",
      cron: "0 8 * * 1",
      timezone: "America/New_York",
      action: { type: "runScript", command: "echo booked haircut" },
    });
    await app.server.rpc.routines.save({
      name: "Daily workspace check",
      cron: "0 9 * * *",
      timezone: "America/New_York",
      action: { type: "runScript", command: "echo original check" },
    });
    await app.server.rpc.routines.save({
      name: "Morning briefing",
      cron: "0 8 * * *",
      timezone: "America/New_York",
      action: { type: "runAgent", prompt: "Original briefing prompt" },
      enabled: false,
    });

    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    await sidebar.getByRole("button", { name: "Expand appointments" }).click();
    await expect(
      sidebar.getByRole("link", { name: "Book haircut" }),
    ).toBeVisible();
    await expect(sidebar.getByText("Scheduled", { exact: true })).toBeVisible();
    await sidebar.getByRole("link", { name: "Morning briefing" }).click();
    const agentRoutine = app.page.getByRole("region", {
      name: "Routine Morning briefing",
    });
    await expect(agentRoutine).toContainText("Original briefing prompt");
    await agentRoutine.getByRole("button", { name: "Edit" }).click();
    await agentRoutine
      .getByRole("textbox", { name: "Agent prompt" })
      .fill("Updated briefing prompt");
    await agentRoutine.getByRole("button", { name: "Save" }).click();
    await expect(agentRoutine).toContainText("Updated briefing prompt");

    await sidebar.getByRole("link", { name: "Daily workspace check" }).click();
    const routine = app.page.getByRole("region", {
      name: "Routine Daily workspace check",
    });
    await expect(routine).toContainText("At 09:00 AM");
    await expect(routine).toContainText("No run sessions yet");
    await expect(routine).toContainText("echo original check");

    await routine.getByRole("button", { name: "Edit" }).click();
    await routine
      .getByRole("textbox", { name: "Script" })
      .fill("echo updated check");
    await routine.getByRole("button", { name: "Save" }).click();
    await expect(routine).toContainText("echo updated check");

    await routine.getByRole("button", { name: "Run now" }).click();
    const session = routine.getByRole("link", {
      name: /Daily workspace check/,
    });
    await expect(session).toBeVisible();
    await expect(routine).toContainText(/Last run\s*Completed/);
    await session.click();

    const command = app.page.getByRole("article", { name: "Shell command" });
    await expect(command).toContainText("$ echo updated check");
    await expect(command).toContainText("updated check");
    await expect(
      sidebar.getByRole("link", { name: /^Daily workspace check · / }),
    ).toBeVisible();
  },
);
