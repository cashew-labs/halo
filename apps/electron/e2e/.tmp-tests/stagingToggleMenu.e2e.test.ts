import { expect } from "@playwright/test";
import { e2eTest } from "../e2eTest.js";

// The desktop API reports each session lookup to StagingToggle, which decides
// whether Help > Use Staging is offered. Test builds never offer it.
e2eTest("session lookups reach the staging toggle without offering it in test builds", async ({ app }) => {
  await expect(app.page.getByTestId("app-update-status")).toBeVisible();
  const lookups = await app.page.evaluate(async () => {
    // SAFETY: the preload exposes the desktop API on window.haloDesktop in Electron.
    const api = (
      window as unknown as {
        haloDesktop: { getAuthSession: () => Promise<unknown>; signIn: () => Promise<unknown> };
      }
    ).haloDesktop;
    return [await api.getAuthSession(), await api.signIn()];
  });
  for (const session of lookups) expect(session).toMatchObject({ user: { email: expect.any(String) } });
  const item = await app.electron.evaluate(({ Menu }) => {
    const found = Menu.getApplicationMenu()?.getMenuItemById("use-staging");
    const byLabel = Menu.getApplicationMenu()
      ?.items.flatMap((menu) => menu.submenu?.items ?? [])
      .find((entry) => entry.label === "Use Staging");
    const menuItem = found ?? byLabel;
    return menuItem === undefined ? undefined : { visible: menuItem.visible };
  });
  expect(item).toEqual({ visible: false });
});
