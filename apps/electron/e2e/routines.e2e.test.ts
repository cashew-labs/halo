import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "edits personal routines and controls their run threads",
  async ({ app, harness }) => {
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send("Emulation.setTimezoneOverride", {
      timezoneId: "America/Los_Angeles",
    });
    await harness.tools.bash.run({
      command: "mkdir -p .halo/extensions/appointments",
    });
    await app.server.rpc.automations.save({
      extensionId: "appointments",
      name: "Book haircut",
      activation: {
        type: "routine",
        schedule: { cron: "0 8 * * 1", timezone: "America/New_York" },
      },
      action: { type: "runScript", command: "echo booked haircut" },
    });
    await app.server.rpc.automations.save({
      name: "Daily workspace check",
      activation: {
        type: "routine",
        schedule: { cron: "0 9 * * *", timezone: "America/New_York" },
      },
      action: { type: "runScript", command: "echo original check" },
    });
    await app.server.rpc.automations.save({
      name: "Morning briefing",
      activation: {
        type: "routine",
        schedule: { cron: "0 8 * * *", timezone: "America/New_York" },
      },
      action: { type: "runAgent", prompt: "Original briefing prompt" },
      enabled: false,
    });

    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    const header = app.page.getByTestId("pane-header");
    await sidebar.getByRole("button", { name: "Expand appointments" }).click();
    await expect(
      sidebar.getByRole("link", { name: "Book haircut" }),
    ).toBeVisible();
    await expect(
      sidebar.getByRole("button", { name: "Collapse Artifacts", exact: true }),
    ).toBeVisible();
    await sidebar.getByRole("link", { name: "Morning briefing" }).click();
    const agentRoutine = app.page.getByRole("region", {
      name: "Automation Morning briefing",
    });
    await expect(agentRoutine).toContainText("Original briefing prompt");
    await header.getByRole("button", { name: "Edit automation" }).click();
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
    await expect(routine).toContainText(/After run\s*Show thread/);
    await expect(
      header.getByRole("button", { name: "Edit automation" }),
    ).toBeVisible();

    await header.getByRole("button", { name: "Edit automation" }).click();
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

    await header.getByRole("button", { name: "Run now" }).click();
    const thread = routine
      .getByRole("region", { name: "Run history" })
      .getByRole("link");
    await expect(thread).toBeVisible();
    await expect(routine).toContainText(/Last run\s*Completed/);
    const automation = (await app.server.rpc.automations.list()).find(
      (item) => item.name === "Daily workspace check",
    )!;
    const [run] = await app.server.rpc.automations.listRuns({
      automationId: automation.id,
    });
    const localTime = formatPacificTime(run!.startedAt);
    await expect(thread).toContainText(localTime);
    await expect(routine).toContainText(`Completed · ${localTime}`);
    await expect(routine).toContainText(
      formatPacificTime(automation.nextRunAt!),
    );
    await thread.click();

    const command = app.page.getByRole("article", { name: "Shell command" });
    await expect(command).toContainText("$ echo updated check");
    await expect(command).toContainText("updated check");
    await expect(
      sidebar.getByRole("link", { name: /^Daily workspace check · / }),
    ).toBeVisible();

    await sidebar
      .getByRole("link", { name: "Daily workspace check", exact: true })
      .click();
    await header.getByRole("button", { name: "Edit automation" }).click();
    await editor.getByRole("button", { name: /Automation status/ }).click();
    await app.page.getByRole("option", { name: "Paused" }).click();
    await editor.getByRole("button", { name: /After run/ }).click();
    await app.page.getByRole("option", { name: "Auto archive thread" }).click();
    await editor.getByRole("button", { name: "Save" }).click();
    await expect(routine).toContainText(/Next run\s*Paused/);
    await expect(routine).toContainText(/After run\s*Auto archive thread/);
    await header.getByRole("button", { name: "Run now" }).click();
    await expect(
      routine.getByRole("region", { name: "Run history" }).getByRole("link"),
    ).toHaveCount(2);
    await expect(
      sidebar.getByRole("link", { name: /^Daily workspace check · / }),
    ).toHaveCount(1);
  },
);

e2eTest(
  "configures a trigger, shows event runs, and edits its activation",
  async ({ app }, testInfo) => {
    const cdp = await app.page.context().newCDPSession(app.page);
    await cdp.send("Emulation.setTimezoneOverride", {
      timezoneId: "America/Los_Angeles",
    });
    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    const header = app.page.getByTestId("pane-header");
    await app.server.rpc.automations.save({
      name: "Incoming order",
      activation: {
        type: "routine",
        schedule: { cron: "0 9 * * *", timezone: "UTC" },
      },
      action: { type: "runAgent", prompt: "Check incoming orders" },
    });
    await sidebar
      .getByRole("link", { name: "Incoming order", exact: true })
      .click();
    const pane = app.page.getByRole("region", {
      name: "Automation Incoming order",
    });
    await header.getByRole("button", { name: "Edit automation" }).click();
    const editor = app.page.getByRole("dialog", {
      name: "Edit Incoming order",
    });
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
    await editor.getByRole("button", { name: "Save", exact: true }).click();
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
    const [run] = await app.server.rpc.automations.listRuns({
      automationId: automation!.id,
    });
    const localTime = formatPacificTime(run!.startedAt);
    await expect(pane.getByRole("link", { name: /Triggered/ })).toContainText(
      localTime,
    );
    await expect(pane).toContainText(`Completed · ${localTime}`);
    await pane.getByRole("link", { name: /Triggered/ }).click();
    await expect(
      app.page.getByRole("article", { name: "Shell command" }),
    ).toContainText("order-123");
    await sidebar
      .getByRole("link", { name: "Incoming order", exact: true })
      .click();
    await header.getByRole("button", { name: "Pause", exact: true }).click();
    await expect(
      header.getByRole("button", { name: "Resume", exact: true }),
    ).toBeVisible();
    await pane
      .getByRole("textbox", { name: "Sample JSON" })
      .fill('{"order":"manual-sample"}');
    await pane.getByRole("button", { name: "Run test", exact: true }).click();
    await expect(
      pane.getByRole("region", { name: "Run history" }),
    ).toContainText("Completed · Run now");
    await header.getByRole("button", { name: "Edit automation" }).click();
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

function formatPacificTime(time: string) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(time));
}
