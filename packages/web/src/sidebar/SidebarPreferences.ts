import * as errore from "errore";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

export const sidebarSectionLabels = {
  favorites: "Favorites",
  artifacts: "Artifacts",
  sessions: "Sessions",
} as const;
const sectionIdSchema = Type.Union([
  Type.Literal("favorites"),
  Type.Literal("artifacts"),
  Type.Literal("sessions"),
]);
export type SidebarSectionId = Static<typeof sectionIdSchema>;
const defaultSectionOrder: SidebarSectionId[] = [
  "favorites",
  "artifacts",
  "sessions",
];
const artifactFilterSchema = Type.Union([
  Type.Literal("all"),
  Type.Literal("documents"),
  Type.Literal("extensions"),
  Type.Literal("automations"),
]);
export type ArtifactFilter = Static<typeof artifactFilterSchema>;
const preferencesSchema = Type.Object({
  favoriteIds: Type.Array(
    Type.String({ pattern: "^(file:|extension:|automation:|session:)" }),
    { uniqueItems: true },
  ),
  sectionOrder: Type.Array(sectionIdSchema, {
    minItems: 3,
    maxItems: 3,
    uniqueItems: true,
  }),
  collapsedSections: Type.Array(sectionIdSchema, { uniqueItems: true }),
  artifactFilter: artifactFilterSchema,
});
type SidebarPreferenceState = Static<typeof preferencesSchema>;

class SidebarStorageError extends errore.createTaggedError({
  name: "SidebarStorageError",
  message: "Could not $operation sidebar preferences",
}) {}

export class SidebarPreferences {
  // Browser navigation preferences belong to the signed-in user and workspace.
  private state: SidebarPreferenceState = {
    favoriteIds: [],
    sectionOrder: defaultSectionOrder,
    collapsedSections: [],
    artifactFilter: "all",
  };
  private readonly listeners = new Set<() => void>();
  private readonly storageKey: string;

  constructor({
    userId,
    workspaceRoot,
  }: {
    userId: string;
    workspaceRoot: string;
  }) {
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
    this.state = parsed;
  }

  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  toggleFavorite(favoriteId: string) {
    const favoriteIds = this.state.favoriteIds.includes(favoriteId)
      ? this.state.favoriteIds.filter((item) => item !== favoriteId)
      : [...this.state.favoriteIds, favoriteId];
    this.publish({ ...this.state, favoriteIds });
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

  moveSection({
    sourceId,
    targetId,
  }: {
    sourceId: SidebarSectionId;
    targetId: SidebarSectionId;
  }) {
    if (sourceId === targetId) return;
    const index = this.state.sectionOrder.indexOf(targetId);
    const sectionOrder = this.state.sectionOrder.filter(
      (item) => item !== sourceId,
    );
    sectionOrder.splice(index, 0, sourceId);
    this.publish({ ...this.state, sectionOrder });
  }

  shiftSection({
    sectionId,
    direction,
  }: {
    sectionId: SidebarSectionId;
    direction: -1 | 1;
  }) {
    const index = this.state.sectionOrder.indexOf(sectionId);
    const targetId = this.state.sectionOrder[index + direction];
    if (targetId !== undefined)
      this.moveSection({ sourceId: sectionId, targetId });
  }

  updateFiles(source: string, destination?: string) {
    const favoriteIds = this.state.favoriteIds.flatMap((favoriteId) => {
      if (!favoriteId.startsWith("file:")) return [favoriteId];
      const path = favoriteId.slice(5);
      if (path !== source && !path.startsWith(`${source}/`))
        return [favoriteId];
      return destination === undefined
        ? []
        : [`file:${destination}${path.slice(source.length)}`];
    });
    this.publish({ ...this.state, favoriteIds: [...new Set(favoriteIds)] });
  }

  private publish(state: SidebarPreferenceState) {
    this.state = state;
    const saved = errore.try({
      try: () =>
        window.localStorage.setItem(this.storageKey, JSON.stringify(state)),
      catch: (cause) => new SidebarStorageError({ operation: "save", cause }),
    });
    if (saved instanceof Error) console.warn(saved);
    for (const listener of this.listeners) listener();
  }
}
