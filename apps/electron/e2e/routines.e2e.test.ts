import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "runs a routine from its page and shows the run's session",
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

    const sidebar = app.page.getByRole("navigation", { name: "Workspace" });
    await sidebar.getByRole("button", { name: "Expand appointments" }).click();
    await sidebar
      .getByRole("link", { name: "Book haircut", exact: true })
      .click();
    const routine = app.page.getByRole("region", {
      name: "Routine Book haircut",
    });
    await expect(routine).toContainText("At 08:00 AM, only on Monday");
    await expect(routine).toContainText("No runs yet");

    await routine.getByRole("button", { name: "Run now" }).click();

    const command = routine.getByRole("article", { name: "Shell command" });
    await expect(command).toContainText("$ echo booked haircut");
    await expect(command).toContainText("Exit code 0");
    await expect(command).toContainText("booked haircut");
    await expect(routine).toContainText(/Last run\s*Completed/);
    await expect(
      sidebar.getByRole("link", { name: /^Book haircut · / }),
    ).toBeVisible();
  },
);
