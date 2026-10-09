import { expect } from "@playwright/test";
import { execa } from "execa";
import path from "node:path";
import { e2eTest } from "../e2eTest.js";

for (const snapshots of [true, false]) {
  const traceTest = snapshots
    ? e2eTest
    : e2eTest.extend({ traceSnapshots: false });
  traceTest(
    `retains action and screenshot evidence with snapshots=${snapshots}`,
    async ({ app, testArtifacts }) => {
      for (const launch of [1, 2]) {
        if (launch === 2) await app.open();
        await expect(app.page.getByRole("main")).toBeVisible();
        await app.page
          .getByRole("button", { name: "New tab", exact: true })
          .click();
        await expect(
          app.page.getByRole("main").getByLabel("Message", { exact: true }),
        ).toBeVisible();
        await app.page.screenshot();
        await app.quit();
        const archive = path.join(
          testArtifacts.paths.root,
          `launch-${launch}.trace.zip`,
        );
        const { stdout } = await execa("unzip", ["-p", archive, "*.trace"], {
          maxBuffer: 20 * 1024 * 1024,
        });
        const entries = stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(
          entries.some(
            (entry) => entry.type === "before" && entry.method === "click",
          ),
        ).toBe(true);
        expect(entries.some((entry) => entry.type === "screencast-frame")).toBe(
          true,
        );
        expect(entries.some((entry) => entry.type === "frame-snapshot")).toBe(
          snapshots,
        );
      }
    },
  );
}
