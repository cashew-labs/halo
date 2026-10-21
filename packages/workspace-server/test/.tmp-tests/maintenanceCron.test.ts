import { expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import { serverTest } from "../serverTest.js";

serverTest(
  "a due automation waits for maintenance cancellation, then resumes through retry",
  async ({ server }) => {
    const realNow = Date.now.bind(Date);
    const offset = Math.ceil(realNow() / 60_000) * 60_000 - 2_000 - realNow();
    const clock = vi
      .spyOn(Date, "now")
      .mockImplementation(() => realNow() + offset);
    try {
      await server.rpc.automations.save({
        name: "Maintenance cron",
        activation: {
          type: "routine",
          schedule: { cron: "* * * * *", timezone: "UTC" },
        },
        action: {
          type: "runScript",
          command: "printf ready > maintenance-marker",
        },
      });
      const url = `${server.transport.origin}/maintenance`;
      const headers = server.transport.headers;
      await expect
        .poll(async () => (await (await fetch(url, { headers })).json()).busy)
        .toBe(false);
      expect((await fetch(url, { method: "POST", headers })).status).toBe(200);
      await new Promise<void>((done) => setTimeout(done, 3_000));
      const marker = path.join(server.workspaceRoot, "maintenance-marker");
      await expect(fs.readFile(marker, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      await fetch(url, { method: "DELETE", headers });
      await expect
        .poll(
          async () => await fs.readFile(marker, "utf8").catch(() => undefined),
          { timeout: 5_000 },
        )
        .toBe("ready");
    } finally {
      clock.mockRestore();
    }
  },
);
