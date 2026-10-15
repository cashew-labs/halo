import { expect, vi } from "vitest";
import { appWorldTest, signIn } from "./appWorld.js";

vi.setConfig({ testTimeout: 120_000 });

appWorldTest("a publish that stops part-way is recorded for the owner in plain words until the app is live", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();

  // Provisioning fails: a generic reason, with the raw error kept for agents.
  provider.failAppEnsures = 1;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } })).rejects.toThrow();
  const [first] = await owner.rpc.apps.list();
  expect(first).toMatchObject({ extensionId: "books", stage: "publishing", publishFailure: { message: "Something went wrong while moving it to its own server.", detail: "app VM provisioning interrupted" } });
  expect(first!.publishFailure!.failedAt).toBeGreaterThan(Date.now() - 60_000);

  // The app starts on its VM neither time: the reason names that, not the sandbox.
  provider.failAppStarts = 2;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } })).rejects.toThrow(/App sandbox failed: start/);
  const [second] = await owner.rpc.apps.list();
  expect(second!.publishFailure).toMatchObject({ message: "Its new server could not start the app.", detail: expect.stringContaining("App sandbox failed: start") });

  // Publishing again finishes and clears the failure.
  provider.failAppStarts = 0;
  const live = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  expect(live.stage).toBe("live");
  expect(live.publishFailure).toBeUndefined();
  expect((await owner.rpc.apps.list())[0]!.publishFailure).toBeUndefined();
});

appWorldTest("keeping a failed publish local removes its record and failure", async ({ appDataDir, plane, provider }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  provider.failAppEnsures = 1;
  await expect(owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } })).rejects.toThrow();
  const [app] = await owner.rpc.apps.list();
  await owner.rpc.apps.cancel({ appId: app!.appId });
  expect(await owner.rpc.apps.list()).toEqual([]);
  // A later publish starts clean.
  const live = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  expect(live).toMatchObject({ stage: "live" });
  expect(live.publishFailure).toBeUndefined();
});

appWorldTest("a refused publish that removes its record leaves no failure behind", async ({ appDataDir, plane }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  await owner.rpc.workspace.ensure();
  // The owner's workspace refuses to freeze a project it does not have.
  await expect(owner.rpc.apps.publish({ extensionId: "missing", access: { visibility: "public", members: [] } })).rejects.toMatchObject({ code: "BAD_REQUEST" });
  expect(await owner.rpc.apps.list()).toEqual([]);
  const live = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  expect(live.publishFailure).toBeUndefined();
});
