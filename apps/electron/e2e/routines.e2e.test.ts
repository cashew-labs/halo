import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "edits personal routines and controls their run sessions",
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
    await expect(
      sidebar.getByText("Automations", { exact: true }),
    ).toBeVisible();
    await sidebar.getByRole("link", { name: "Morning briefing" }).click();
    const agentRoutine = app.page.getByRole("region", {
      name: "Automation Morning briefing",
    });
    await expect(agentRoutine).toContainText("Original briefing prompt");
    await agentRoutine.getByRole("button", { name: "Edit automation" }).click();
    const agentEditor = app.page.getByRole("dialog", {
      name: "Edit Morning briefing",
    });
    await expect(
      agentEditor.getByRole("button", { name: /Automation status/ }),
    ).toContainText("Paused");
    await agentEditor
      .getByRole("button", { name: /Automation status/ })
      .click();
    await app.page.getByRole("option", { name: "Active" }).click();
    await agentEditor
      .getByRole("textbox", { name: "Agent prompt" })
      .fill("Updated briefing prompt");
    await agentEditor.getByRole("button", { name: "Save" }).click();
    await expect(agentRoutine).toContainText("Updated briefing prompt");
    await expect(agentRoutine).not.toContainText(/Next run\s*Paused/);

    await sidebar.getByRole("link", { name: "Daily workspace check" }).click();
    const routine = app.page.getByRole("region", {
      name: "Automation Daily workspace check",
    });
    await expect(routine).toContainText("At 09:00 AM");
    await expect(routine).toContainText("No runs yet");
    await expect(routine).toContainText("echo original check");
    await expect(routine).toContainText(/After run\s*Show session/);
    await expect(
      routine.getByRole("button", { name: "Edit automation" }),
    ).toBeVisible();

    await routine.getByRole("button", { name: "Edit automation" }).click();
    const editor = app.page.getByRole("dialog", {
      name: "Edit Daily workspace check",
    });
    await editor
      .getByRole("textbox", { name: "Schedule (cron)" })
      .fill("invalid");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor.getByRole("alert")).toContainText("five-field cron");
    await editor
      .getByRole("textbox", { name: "Schedule (cron)" })
      .fill("30 10 * * *");
    await editor.getByRole("textbox", { name: "Time zone" }).fill("UTC");
    await editor
      .getByRole("textbox", { name: "Script" })
      .fill("echo updated check");
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(editor).not.toBeVisible();
    await expect(routine).toContainText("echo updated check");
    await expect(routine).toContainText("At 10:30 AM (UTC)");

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

    await sidebar
      .getByRole("link", { name: "Daily workspace check", exact: true })
      .click();
    await routine.getByRole("button", { name: "Edit automation" }).click();
    await editor.getByRole("button", { name: /Automation status/ }).click();
    await app.page.getByRole("option", { name: "Paused" }).click();
    await editor.getByRole("button", { name: /After run/ }).click();
    await app.page
      .getByRole("option", { name: "Auto archive session" })
      .click();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(routine).toContainText(/Next run\s*Paused/);
    await expect(routine).toContainText(/After run\s*Auto archive session/);
    await routine.getByRole("button", { name: "Run now" }).click();
    await expect(
      routine.getByRole("link", { name: /Daily workspace check/ }),
    ).toHaveCount(2);
    await expect(
      sidebar.getByRole("link", { name: /^Daily workspace check · / }),
    ).toHaveCount(1);
  },
);

e2eTest(
  "creates a trigger, shows event runs, and edits its activation",
  async ({ app }, testInfo) => {
    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    await sidebar.getByRole("link", { name: "All automations" }).click();
    await app.page.getByRole("button", { name: "New automation" }).click();
    const editor = app.page.getByRole("dialog", { name: "New automation" });
    await editor
      .getByRole("textbox", { name: "Name", exact: true })
      .fill("Incoming order");
    await editor.getByRole("button", { name: /Activation$/ }).click();
    await app.page
      .getByRole("option", { name: "Trigger", exact: true })
      .click();
    await expect(
      editor.getByRole("button", { name: /Trigger kind/ }),
    ).toContainText("Webhook");
    await editor.getByRole("button", { name: /Action$/ }).click();
    await app.page.getByRole("option", { name: "Script", exact: true }).click();
    await editor
      .getByRole("textbox", { name: "Script", exact: true })
      .fill('cat "$HALO_AUTOMATION_EVENT_FILE"');
    await editor.getByRole("button", { name: "Create", exact: true }).click();
    const pane = app.page.getByRole("region", {
      name: "Automation Incoming order",
    });
    await expect(pane).toContainText("Trigger · Webhook");
    await expect(pane).toContainText("Needs attention");
    await testInfo.attach("Webhook automation", {
      body: await app.page.screenshot(),
      contentType: "image/png",
    });
    const automation = (await app.server.rpc.automations.list()).find(
      (item) => item.name === "Incoming order",
    );
    expect(automation).toBeDefined();
    await app.server.rpc.automations.acceptEvent({
      automationId: automation!.id,
      revision: automation!.revision,
      eventId: "ui-order-1",
      occurredAt: new Date().toISOString(),
      source: "webhook",
      payload: { order: "order-123" },
    });
    await expect(
      pane.getByRole("region", { name: "Run history" }),
    ).toContainText("Completed · Triggered");
    await pane.getByRole("link", { name: /Triggered/ }).click();
    await expect(
      app.page.getByRole("article", { name: "Shell command" }),
    ).toContainText("order-123");
    await sidebar
      .getByRole("link", { name: "Incoming order", exact: true })
      .click();
    await pane.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
      pane.getByRole("button", { name: "Resume", exact: true }),
    ).toBeVisible();
    await pane
      .getByRole("textbox", { name: "Sample JSON" })
      .fill('{"order":"manual-sample"}');
    await pane.getByRole("button", { name: "Run test", exact: true }).click();
    await expect(
      pane.getByRole("region", { name: "Run history" }),
    ).toContainText("Completed · Run now");
    await pane.getByRole("button", { name: "Edit automation" }).click();
    const edit = app.page.getByRole("dialog", { name: "Edit Incoming order" });
    await edit.getByRole("button", { name: /Activation$/ }).click();
    await app.page
      .getByRole("option", { name: "Routine", exact: true })
      .click();
    await edit
      .getByRole("textbox", { name: "Script", exact: true })
      .fill("echo scheduled order check");
    await edit.getByRole("button", { name: "Save", exact: true }).click();
    await expect(pane).toContainText(/Activation\s*Routine/);
    await expect(
      pane.getByRole("region", { name: "Run history" }),
    ).toContainText("Completed · Triggered");
  },
);
