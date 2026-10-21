// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, test } from "vitest";
import type { SidebarPreferences } from "../SidebarPreferences.js";
import {
  SidebarPreferencesProvider,
  useSidebarPreferences,
} from "../SidebarPreferencesProvider.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("switching workspace reads that workspace's own preferences", async () => {
  window.localStorage.clear();
  const seen: SidebarPreferences[] = [];
  function Probe() {
    seen.push(useSidebarPreferences());
    return null;
  }
  const root = createRoot(document.createElement("div"));
  const render = async (workspaceRoot: string) =>
    await act(async () =>
      root.render(
        <SidebarPreferencesProvider userId="user" workspaceRoot={workspaceRoot}>
          <Probe />
        </SidebarPreferencesProvider>,
      ),
    );
  await render("/one");
  seen.at(-1)!.toggleFavorite("file:One.md");
  await render("/two");
  expect(seen.at(-1)!.getSnapshot().favoriteIds).toEqual([]);
  await render("/one");
  expect(seen.at(-1)!.getSnapshot().favoriteIds).toEqual(["file:One.md"]);
  await act(async () => root.unmount());
});
