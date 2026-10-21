import { expect, test, vi } from "vitest";
import { WorkspaceMaintenance } from "../server/WorkspaceMaintenance.js";

test("maintenance reserves atomically and abandoned reservations expire", () => {
  let idle = true;
  const maintenance = new WorkspaceMaintenance({ isWorkIdle: () => idle });
  expect(maintenance.busy).toBe(false);
  const task = maintenance.enter();
  if (task instanceof Error) throw task;
  expect(maintenance.prepare(false)).toBe(false);
  task[Symbol.dispose]();
  idle = false;
  expect(maintenance.prepare(false)).toBe(false);
  expect(maintenance.prepare(true)).toBe(true);
  expect(maintenance.enter()).toBeInstanceOf(Error);
  maintenance.cancel();
  idle = true;
  expect(maintenance.prepare(false)).toBe(true);
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 121_000);
  try {
    expect(maintenance.upgrading).toBe(false);
    const next = maintenance.enter();
    if (next instanceof Error) throw next;
    next[Symbol.dispose]();
  } finally {
    clock.mockRestore();
  }
});
