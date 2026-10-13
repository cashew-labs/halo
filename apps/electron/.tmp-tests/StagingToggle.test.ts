import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
import { expect, test } from "vitest";
import { StagingToggle } from "../src/main/app/StagingToggle.js";

function session(stagingAccess?: boolean): ControlPlaneSession {
  return {
    session: { id: "s", userId: "u", expiresAt: "2026-10-14T00:00:00.000Z" },
    user: { id: "u", email: "tester@example.com", name: "Tester" },
    ...(stagingAccess === undefined ? {} : { stagingAccess }),
  };
}

test("production installs offer staging only after a session grants it", () => {
  let changes = 0;
  const toggle = new StagingToggle({ onChange: () => changes++ });
  expect(toggle.isOffered("production")).toBe(false);
  toggle.observe(session(true));
  expect(toggle.isOffered("production")).toBe(true);
  expect(changes).toBe(1);
  // The same answer again does not rebuild the menu.
  toggle.observe(session(true));
  expect(changes).toBe(1);
});

test("a lookup error keeps the answer; signing out or an older server hides it", () => {
  let changes = 0;
  const toggle = new StagingToggle({ onChange: () => changes++ });
  toggle.observe(session(true));
  toggle.observe(new Error("offline"));
  expect(toggle.isOffered("production")).toBe(true);
  toggle.observe(undefined);
  expect(toggle.isOffered("production")).toBe(false);
  toggle.observe(session(true));
  toggle.observe(session());
  expect(toggle.isOffered("production")).toBe(false);
  expect(changes).toBe(4);
});

test("a staging install always offers the way back", () => {
  const toggle = new StagingToggle({ onChange: () => {} });
  expect(toggle.isOffered("staging")).toBe(true);
  toggle.observe(session(false));
  expect(toggle.isOffered("staging")).toBe(true);
});
