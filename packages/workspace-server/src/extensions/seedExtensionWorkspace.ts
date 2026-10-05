import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import * as errore from "errore";
import type { WorkspaceLayout } from "../workspace/WorkspaceService.js";
import type {
  FilesystemError,
  FilesystemService,
} from "../filesystem/FilesystemService.js";

export class ExtensionSeedError extends errore.createTaggedError({
  name: "ExtensionSeedError",
  message: "Failed to seed workspace extension guidance",
}) {}

export async function seedExtensionWorkspace(
  filesystem: FilesystemService,
  layout: WorkspaceLayout,
) {
  const skillsDirectory = join(layout.root, ".agents", "skills");
  for (const name of ["halo-extension", "maui", "pdf"]) {
    const removed = await filesystem.remove(
      join(layout.agentDir, "skills", name),
      {
        recursive: true,
        force: true,
      },
    );
    if (removed instanceof Error)
      return new ExtensionSeedError({ cause: removed });
  }

  const haloExtension = await copySkillDirectory({
    filesystem,
    source: join(import.meta.dirname, "skills", "halo-extension"),
    destination: join(skillsDirectory, "halo-extension"),
  });
  if (haloExtension instanceof Error)
    return new ExtensionSeedError({ cause: haloExtension });

  const pdf = await copySkillDirectory({
    filesystem,
    source: join(import.meta.dirname, "skills", "pdf"),
    destination: join(skillsDirectory, "pdf"),
  });
  if (pdf instanceof Error) return new ExtensionSeedError({ cause: pdf });

  const maui = await copySkillDirectory({
    filesystem,
    source: mauiSkillDirectory(),
    destination: join(skillsDirectory, "maui"),
  });
  if (maui instanceof Error) return new ExtensionSeedError({ cause: maui });
}

// The Maui skill ships SKILL.md plus a references/ tree that it links to.
function mauiSkillDirectory() {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve("maui/package.json")), "skills", "maui");
}

async function copySkillDirectory(args: {
  filesystem: FilesystemService;
  source: string;
  destination: string;
}) {
  const removed = await args.filesystem.remove(args.destination, {
    recursive: true,
    force: true,
  });
  if (removed instanceof Error) return removed;
  return await copyDirectory(args);
}

async function copyDirectory(args: {
  filesystem: FilesystemService;
  source: string;
  destination: string;
}): Promise<FilesystemError | undefined> {
  const entries = await args.filesystem.listDirectory(args.source);
  if (entries instanceof Error) return entries;
  const created = await args.filesystem.makeDirectory(args.destination, {
    recursive: true,
  });
  if (created instanceof Error) return created;

  for (const entry of entries) {
    const source = join(args.source, entry.name);
    const destination = join(args.destination, entry.name);
    if (entry.isDirectory()) {
      const copied = await copyDirectory({
        filesystem: args.filesystem,
        source,
        destination,
      });
      if (copied instanceof Error) return copied;
      continue;
    }
    const contents = await args.filesystem.readFile(source);
    if (contents instanceof Error) return contents;
    const written = await args.filesystem.writeFile(destination, contents);
    if (written instanceof Error) return written;
  }
}
