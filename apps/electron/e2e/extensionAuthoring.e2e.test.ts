import { expect } from "@playwright/test";
import { m } from "@get-halo/shared/testing";
import { e2eTest } from "./e2eTest.js";

e2eTest(
  "authors and loads an extension through the agent's shell and file tools",
  async ({ harness, app }) => {
    e2eTest.setTimeout(120_000);
    const harnessBashTimeoutMs = 120_000;
    await app.page.getByRole("main").waitFor();
    await app.page.evaluate(() =>
      document.documentElement.setAttribute(
        "data-extension-authoring",
        "original",
      ),
    );
    const created = await harness.tools.bash.run({
      command: "halo extension new greeting",
      timeoutMs: harnessBashTimeoutMs,
    });
    expect(created.code, `${created.stdout}\n${created.stderr}`).toBe(0);

    await harness.tools.files.write({
      path: ".halo/extensions/greeting/view.tsx",
      content: `
        import { Flex, H1, MauiProvider } from "maui";

        export default function View() {
          return (
            <MauiProvider>
              <Flex column p={8}><H1>Authored through Halo tools</H1></Flex>
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

    await expect(app.page.locator("html")).toHaveAttribute(
      "data-extension-authoring",
      "original",
    );
    await app.page.getByRole("link", { name: "greeting", exact: true }).click();
    const pane = app.page.locator('iframe[title="greeting"]').contentFrame();
    await expect(
      pane.getByRole("heading", { name: "Authored through Halo tools" }),
    ).toBeVisible();

    await harness.tools.files.write({
      path: ".halo/extensions/greeting/view.tsx",
      content: `
        import { Flex, H1, MauiProvider } from "maui";

        export default function View() {
          return (
            <MauiProvider>
              <Flex column p={8}><H1>Updated through Halo tools</H1></Flex>
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

e2eTest(
  "builds a working extension through the agent loop from a simple prompt",
  async ({ app, llm }) => {
    e2eTest.setTimeout(180_000);
    const viewSource = `
      import { useState } from "react";
      import { Button, Flex, H1, MauiProvider } from "maui";

      export default function View() {
        const [count, setCount] = useState(0);
        return (
          <MauiProvider>
            <Flex column gap={4} p={8}>
              <H1>Agent Counter</H1>
              <Button onClick={() => setCount((value) => value + 1)}>
                Count: {count}
              </Button>
            </Flex>
          </MauiProvider>
        );
      }
    `;
    const authoringJs = `
      const created = await tools.bash.run({
        command: "halo extension new agent-counter",
        timeoutMs: 120000,
      });
      if (!created.ok) return created;
      const written = await tools.files.write({
        path: ".halo/extensions/agent-counter/view.tsx",
        content: ${JSON.stringify(viewSource)},
      });
      if (!written.ok) return written;
      return await tools.bash.run({
        command: "cd .halo/extensions/agent-counter && npm run check && npm run build && halo extension reload",
        timeoutMs: 120000,
      });
    `;

    await app.page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const session = app.page.getByRole("main", {
      name: "New session",
      exact: true,
    });
    await session
      .getByLabel("Message", { exact: true })
      .fill("Build me a simple counter extension called Agent Counter.");
    await session.getByRole("button", { name: "Send", exact: true }).click();
    await llm.respond(
      m.tool.start("exec", {
        id: "build-agent-counter",
        arguments: { js: authoringJs },
      }),
    );
    await llm.respond(
      m.assistant("Built and loaded the Agent Counter extension."),
    );
    await expect(
      app.page.getByText("Built and loaded the Agent Counter extension."),
    ).toBeVisible();

    await app.page
      .getByRole("link", { name: "agent-counter", exact: true })
      .click();
    const pane = app.page
      .locator('iframe[title="agent-counter"]')
      .contentFrame();
    await expect(
      pane.getByRole("heading", { name: "Agent Counter" }),
    ).toBeVisible();
    const counter = pane.getByRole("button", { name: "Count: 0" });
    await counter.click();
    await expect(pane.getByRole("button", { name: "Count: 1" })).toBeVisible();
  },
);
