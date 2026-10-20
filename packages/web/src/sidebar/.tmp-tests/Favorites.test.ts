// @vitest-environment happy-dom
import { beforeEach, expect, test, vi } from "vitest";
import { SidebarPreferences } from "../SidebarPreferences.js";

const scope = { userId: "test-user", workspaceRoot: "/test/workspace" };
const storageKey = `halo:sidebar:${JSON.stringify([scope.userId, scope.workspaceRoot])}`;
beforeEach(() => window.localStorage.clear());

test("restores ordered favorites only for the same user and workspace", () => {
  const favorites = new SidebarPreferences(scope);
  const listener = vi.fn();
  const unsubscribe = favorites.subscribe(listener);
  favorites.toggleFavorite("file:Brief.md");
  favorites.toggleFavorite("extension:notes");
  favorites.toggleFavorite("session:one");
  expect(listener).toHaveBeenCalledTimes(3);
  expect(new SidebarPreferences(scope).getSnapshot().favoriteIds).toEqual(["file:Brief.md", "extension:notes", "session:one"]);
  expect(new SidebarPreferences({ ...scope, userId: "another-user" }).getSnapshot().favoriteIds).toEqual([]);
  expect(new SidebarPreferences({ ...scope, workspaceRoot: "/other" }).getSnapshot().favoriteIds).toEqual([]);
  favorites.toggleFavorite("extension:notes");
  expect(favorites.getSnapshot().favoriteIds).toEqual(["file:Brief.md", "session:one"]);
  unsubscribe();
  favorites.toggleFavorite("automation:daily");
  expect(listener).toHaveBeenCalledTimes(4);
});

test("follows renamed directories and removes deleted descendants without touching siblings", () => {
  const favorites = new SidebarPreferences(scope);
  for (const favoriteId of ["file:Research/", "file:Research/Findings.md", "file:Researcher.md", "extension:Research", "automation:one"]) favorites.toggleFavorite(favoriteId);
  favorites.updateFiles("Research", "Notes & ideas");
  expect(favorites.getSnapshot().favoriteIds).toEqual(["file:Notes & ideas/", "file:Notes & ideas/Findings.md", "file:Researcher.md", "extension:Research", "automation:one"]);
  expect(new SidebarPreferences(scope).getSnapshot().favoriteIds).toEqual(favorites.getSnapshot().favoriteIds);
  favorites.updateFiles("Notes & ideas");
  expect(favorites.getSnapshot().favoriteIds).toEqual(["file:Researcher.md", "extension:Research", "automation:one"]);
});

test("reports corrupt stored preferences and still allows new favorites", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  for (const value of ["{broken", '{"invalid":true}', '["file:a","file:a"]']) {
    window.localStorage.setItem(storageKey, value);
    const favorites = new SidebarPreferences(scope);
    expect(favorites.getSnapshot().favoriteIds).toEqual([]);
    favorites.toggleFavorite("file:New.md");
    expect(new SidebarPreferences(scope).getSnapshot().favoriteIds).toEqual(["file:New.md"]);
  }
  expect(warning).toHaveBeenCalledTimes(3);
  warning.mockRestore();
});

test("saves collapsed sections, section ordering, and the artifact filter", () => {
  const preferences = new SidebarPreferences(scope);
  preferences.toggleFavorite("file:Brief.md");
  preferences.setSectionExpanded("sessions", false);
  preferences.moveSection({ sourceId: "artifacts", targetId: "favorites" });
  preferences.setArtifactFilter("extensions");
  const restored = new SidebarPreferences(scope);
  expect(restored.getSnapshot()).toEqual({
    favoriteIds: ["file:Brief.md"],
    sectionOrder: ["artifacts", "favorites", "sessions"],
    collapsedSections: ["sessions"],
    artifactFilter: "extensions",
  });
  restored.shiftSection({ sectionId: "artifacts", direction: 1 });
  restored.shiftSection({ sectionId: "favorites", direction: -1 });
  restored.setSectionExpanded("sessions", true);
  expect(restored.getSnapshot().sectionOrder).toEqual(["favorites", "artifacts", "sessions"]);
  expect(restored.getSnapshot().collapsedSections).toEqual([]);
  expect(new SidebarPreferences(scope).getSnapshot()).toEqual(restored.getSnapshot());
});

test("revealing documents expands Artifacts and clears filters that hide files", () => {
  const preferences = new SidebarPreferences(scope);
  preferences.setSectionExpanded("artifacts", false);
  preferences.setArtifactFilter("automations");
  preferences.revealDocuments();
  expect(preferences.getSnapshot()).toMatchObject({ collapsedSections: [], artifactFilter: "all" });
  preferences.setArtifactFilter("documents");
  preferences.revealDocuments();
  expect(preferences.getSnapshot().artifactFilter).toBe("documents");
});

test("drops preferences saved with the old per-kind sections", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  window.localStorage.setItem(storageKey, JSON.stringify({
    favoriteIds: ["file:Brief.md"],
    sectionOrder: ["favorites", "automations", "extensions", "documents", "sessions"],
    collapsedSections: [],
  }));
  expect(new SidebarPreferences(scope).getSnapshot()).toEqual({
    favoriteIds: [], sectionOrder: ["favorites", "artifacts", "sessions"], collapsedSections: [], artifactFilter: "all",
  });
  expect(warning).toHaveBeenCalledTimes(1);
  warning.mockRestore();
});

test("reports blocked browser storage and retains usable in-memory preferences", () => {
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const access = vi.spyOn(window, "localStorage", "get").mockImplementation(() => { throw new Error("Storage is blocked"); });
  const preferences = new SidebarPreferences(scope);
  expect(preferences.getSnapshot().favoriteIds).toEqual([]);
  const listener = vi.fn();
  preferences.subscribe(listener);
  preferences.toggleFavorite("file:Brief.md");
  expect(listener).toHaveBeenCalledTimes(1);
  expect(preferences.getSnapshot().favoriteIds).toEqual(["file:Brief.md"]);
  preferences.shiftSection({sectionId: "favorites", direction: -1});
  preferences.shiftSection({sectionId: "sessions", direction: 1});
  expect(preferences.getSnapshot().sectionOrder).toEqual(["favorites", "artifacts", "sessions"]);
  expect(warning).toHaveBeenCalledTimes(2);
  access.mockRestore();
  warning.mockRestore();
});
