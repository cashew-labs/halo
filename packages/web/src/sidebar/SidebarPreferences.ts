import * as errore from "errore";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

// Section IDs are persisted browser layout preferences.
// Keep the legacy "sessions" and "session:" values when displaying threads.
export const sidebarSectionLabels = {
  favorites: "Favorites",
  artifacts: "Artifacts",
  sessions: "Threads",
} as const;
const sectionIdSchema = Type.Union([
  Type.Literal("favorites"),
  Type.Literal("artifacts"),
  Type.Literal("sessions"),
]);
export type SidebarSectionId = Static<typeof sectionIdSchema>;
const artifactFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("documents"),
  Type.Literal("extensions"),
  Type.Literal("automations"),
]);
export type ArtifactFilter = Static<typeof artifactFilterSchema>;
const storedFavoriteIdsSchema = Type.Array(
  Type.String({ pattern: "^(file:|extension:|automation:|session:)" }),
  { uniqueItems: true },
);
const preferencesSchema = Type.Object({
  collapsedSections: Type.Array(sectionIdSchema, { uniqueItems: true }),
  artifactFilter: artifactFilterSchema,
});
type SidebarPreferenceState = Static<typeof preferencesSchema> & {
  favoriteIds: string[];
};

class SidebarStorageError extends errore.createTaggedError({
  name: "SidebarStorageError",
  message: "Could not $operation sidebar preferences",
}) {}

export class SidebarPreferences {
  // Browser navigation preferences belong to the signed-in user and workspace.
  private state: SidebarPreferenceState = {
    favoriteIds: [],
    collapsedSections: [],
    artifactFilter: "all",
  };
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;
  // Retain the old list until the VM acknowledges the import.
  private storedFavoriteIds: string[] | undefined;
  private readonly favorites: {
    add(favoriteIds: string[]): Promise<void>;
    toggle(favoriteId: string): void;
    updateFiles(source: string, destination?: string): void;
  };

  constructor({
    userId,
    workspaceRoot,
    favorites,
  }: {
    userId: string;
    workspaceRoot: string;
    favorites: SidebarPreferences["favorites"];
  }) {
    this.favorites = favorites;
    this.storageKey = `halo:sidebar:${JSON.stringify([userId, workspaceRoot])}`;
    const stored = errore.try({
      try: () => window.localStorage.getItem(this.storageKey),
      catch: (cause) => new SidebarStorageError({ operation: "read", cause }),
    });
    if (stored instanceof Error) {
      console.warn(stored);
      return;
    }
    if (stored === null) return;
    const parsed = errore.try({
      // SAFETY: Persisted input is validated before use.
      try: () => JSON.parse(stored) as unknown,
      catch: (cause) =>
        new SidebarStorageError({ operation: "restore", cause }),
    });
    if (parsed instanceof Error) {
      console.warn(parsed);
      return;
    }
    if (!Value.Check(preferencesSchema, parsed)) {
      console.warn(new SidebarStorageError({ operation: "restore" }));
      return;
    }
    this.state = {
      collapsedSections: parsed.collapsedSections,
      artifactFilter: parsed.artifactFilter,
      favoriteIds: [],
    };
    if (
      "favoriteIds" in parsed &&
      Value.Check(storedFavoriteIdsSchema, parsed.favoriteIds)
    )
      this.storedFavoriteIds = parsed.favoriteIds;
  }

  async importFavorites() {
    if (this.storedFavoriteIds === undefined) return;
    await this.favorites.add(this.storedFavoriteIds);
    this.storedFavoriteIds = undefined;
    this.publish(this.state);
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setFavoriteIds(favoriteIds: string[]) {
    this.state = { ...this.state, favoriteIds };
    for (const listener of this.listeners) listener();
  }

  toggleFavorite(favoriteId: string) {
    this.favorites.toggle(favoriteId);
  }

  setSectionExpanded(sectionId: SidebarSectionId, expanded: boolean) {
    const collapsedSections = expanded
      ? this.state.collapsedSections.filter((item) => item !== sectionId)
      : [...new Set([...this.state.collapsedSections, sectionId])];
    this.publish({ ...this.state, collapsedSections });
  }

  setArtifactFilter(artifactFilter: ArtifactFilter) {
    this.publish({ ...this.state, artifactFilter });
  }

  // New files and folders must be visible while their name is entered.
  revealDocuments() {
    const { artifactFilter, collapsedSections } = this.state;
    this.publish({
      ...this.state,
      collapsedSections: collapsedSections.filter(
        (item) => item !== "artifacts",
      ),
      artifactFilter: artifactFilter === "documents" ? "documents" : "all",
    });
  }

  updateFiles(source: string, destination?: string) {
    this.favorites.updateFiles(source, destination);
  }

  private publish(state: SidebarPreferenceState) {
    this.state = state;
    const { favoriteIds: _favoriteIds, ...layout } = state;
    const stored: Static<typeof preferencesSchema> & {
      favoriteIds?: string[];
    } = layout;
    if (this.storedFavoriteIds !== undefined)
      stored.favoriteIds = this.storedFavoriteIds;
    const saved = errore.try({
      try: () =>
        window.localStorage.setItem(this.storageKey, JSON.stringify(stored)),
      catch: (cause) => new SidebarStorageError({ operation: "save", cause }),
    });
    if (saved instanceof Error) console.warn(saved);
    for (const listener of this.listeners) listener();
  }
}
