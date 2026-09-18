import { expect } from "@playwright/test";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "authors and loads an extension through the agent's shell and file tools",
  async ({ harness, app }) => {
    e2eTest.setTimeout(120_000);
    const harnessBashTimeoutMs = 120_000;
    const created = await harness.tools.bash.run({
      command: "halo extension new greeting",
      timeoutMs: harnessBashTimeoutMs,
    });
    expect(created.code, `${created.stdout}\n${created.stderr}`).toBe(0);

    await harness.tools.files.write({
      path: ".halo/extensions/greeting/view.tsx",
      content: `
        import { H1, MauiProvider, Padding } from "maui";

        export default function View() {
          return (
            <MauiProvider>
              <Padding xy={8}><H1>Authored through Halo tools</H1></Padding>
            </MauiProvider>
          );
        }
      `,
    });

    const built = await harness.tools.bash.run({
      command: "cd .halo/extensions/greeting && npm run build",
      timeoutMs: harnessBashTimeoutMs,
    });
    expect(built.code, `${built.stdout}\n${built.stderr}`).toBe(0);

    const reloaded = await harness.tools.bash.run({
      command: "halo extension reload",
      timeoutMs: harnessBashTimeoutMs,
    });
    expect(reloaded.code, `${reloaded.stdout}\n${reloaded.stderr}`).toBe(0);

    const listed = await harness.tools.bash.run({
      command: "halo extension list",
      timeoutMs: harnessBashTimeoutMs,
    });
    expect(listed.code, `${listed.stdout}\n${listed.stderr}`).toBe(0);
    expect(listed.stdout).toContain("greeting");
    expect(listed.stdout).toContain("http://127.0.0.1:");

    await app.page.reload();
    await app.page.getByRole("link", { name: "greeting", exact: true }).click();
    const pane = app.page.locator('iframe[title="greeting"]').contentFrame();
    await expect(
      pane.getByRole("heading", { name: "Authored through Halo tools" }),
    ).toBeVisible();

    await harness.tools.files.write({
      path: ".halo/extensions/greeting/view.tsx",
      content: `
        import { H1, MauiProvider, Padding } from "maui";

        export default function View() {
          return (
            <MauiProvider>
              <Padding xy={8}><H1>Updated through Halo tools</H1></Padding>
            </MauiProvider>
          );
        }
      `,
    });
    const updated = await harness.tools.bash.run({
      command: "halo extension update greeting",
      timeoutMs: harnessBashTimeoutMs,
    });
    expect(updated.code, `${updated.stdout}\n${updated.stderr}`).toBe(0);

    await app.page.reload();
    await app.page.getByRole("link", { name: "greeting", exact: true }).click();
    await expect(
      app.page
        .locator('iframe[title="greeting"]')
        .contentFrame()
        .getByRole("heading", { name: "Updated through Halo tools" }),
    ).toBeVisible();
  },
);
