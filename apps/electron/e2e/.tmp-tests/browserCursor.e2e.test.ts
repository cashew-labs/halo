import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { expect, type Page } from "@playwright/test";
import { webkit, chromium } from "playwright";
import { betterAuth } from "better-auth";
import { testUtils } from "better-auth/plugins";
import * as errore from "errore";
import { ControlPlane } from "../../../control-plane/src/server/ControlPlane.js";
import { LocalWorkspaceProvider } from "../../../control-plane/src/workspace/provider/local/LocalWorkspaceProvider.js";
import { e2eTest } from "../e2eTest.js";

const auth = {
  secret: "test-control-plane-auth-secret-key!",
  googleClientId: "test-google-client-id.apps.googleusercontent.com",
  googleClientSecret: "test-google-client-secret",
};
const mobileTest = e2eTest.extend<{
  mobilePage: Page;
  engine: "webkit" | "chromium";
}>({
  engine: ["webkit", { option: true }],
  mobilePage: async ({ testArtifacts, engine }, use) => {
    const plane = await ControlPlane.start({
      config: {
        deployment: "local",
        workspace: { deployment: "local" },
        appDataDir: testArtifacts.paths.userData,
        port: 0,
        auth,
      },
      webRoot: path.resolve(import.meta.dirname, "../../../web-app/dist"),
      workspaceProvider: new LocalWorkspaceProvider({
        appDataDir: testArtifacts.paths.userData,
      }),
    });
    if (plane instanceof Error) throw plane;
    await using cleanup = new errore.AsyncDisposableStack();
    cleanup.defer(async () => {
      const closed = await plane.close();
      if (closed instanceof Error) throw closed;
    });
    using database = new DatabaseSync(
      path.join(testArtifacts.paths.userData, "control-plane.db"),
    );
    const testAuth = betterAuth({
      baseURL: plane.origin,
      secret: auth.secret,
      database,
      plugins: [testUtils()],
    });
    const authContext = await testAuth.$context;
    const user = authContext.test.createUser({
      email: "owner@example.com",
      name: "Workspace Owner",
    });
    await authContext.test.saveUser(user);
    const login = await authContext.test.login({ userId: user.id });
    const cookie = login.headers.get("cookie");
    if (cookie === null) throw new Error("No test cookie");
    const browser = await (engine === "webkit" ? webkit : chromium).launch();
    cleanup.defer(async () => await browser.close());
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 1,
      extraHTTPHeaders: { cookie },
    });
    const page = await context.newPage();
    page.on("pageerror", console.error);
    await page.goto(plane.origin);
    await use(page);
  },
});
for (const engine of ["webkit", "chromium"] as const) {
  mobileTest.describe(engine, () => {
    mobileTest.use({ engine });
    mobileTest(
      "tap and type in the mobile composer",
      async ({ mobilePage: page }, testInfo) => {
        const input = page
          .locator('[data-testid="pane-tab-content"]:visible')
          .getByLabel("Message", { exact: true });
        await input.fill(
          Array.from(
            { length: 16 },
            (_, index) =>
              `Paragraph ${index}: enough words to wrap on a phone and scroll while typing.`,
          ).join("\n\n"),
        );
        for (const index of [0, 15, 5]) {
          const paragraph = input
            .locator("p")
            .filter({ hasText: new RegExp(`^Paragraph (?:HERE)?${index}:`) });
          await paragraph.scrollIntoViewIfNeeded();
          await expect(paragraph).toBeInViewport();
          const point = await paragraph.evaluate((el) => {
            const range = document.createRange();
            range.setStart(el.firstChild!, 10);
            range.collapse(true);
            const rect = range.getClientRects()[0]!;
            return { x: rect.left, y: rect.top + rect.height / 2 };
          });
          await page.touchscreen.tap(point.x, point.y);
          await page.keyboard.insertText("HERE");
          await expect(paragraph).toHaveText(
            `Paragraph HERE${index}: enough words to wrap on a phone and scroll while typing.`,
          );
          await expect(input).not.toHaveCSS("caret-color", "rgba(0, 0, 0, 0)");
          await expect(
            page.locator(".halo-editor-caret").filter({ visible: true }),
          ).toHaveCount(0);
        }
        await page.screenshot({
          path: testInfo.outputPath(`${engine}-scrolled-composer-390x844.png`),
          caret: "initial",
        });
      },
    );
  });
}
