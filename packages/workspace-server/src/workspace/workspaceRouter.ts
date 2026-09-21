import { implement } from "@orpc/server";
import type { Logger } from "@get-halo/logger";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { WorkspaceService } from "./WorkspaceService.js";

export type WorkspaceRouterContext = {
  workspace: WorkspaceService;
  logger: Logger;
};

const os = implement(contract.workspace).$context<WorkspaceRouterContext>();

export const workspaceRouter = os.router({
  get: os.get.handler(({ context }) => {
    context.logger.info({ event: "getWorkspace" });
    return context.workspace.getWorkspace();
  }),
  listPaths: os.listPaths.handler(async ({ context }) => {
    context.logger.info({ event: "listWorkspacePaths" });
    const paths = await context.workspace.listPaths();
    if (paths instanceof Error) return orpcErrors.badRequest(paths);
    return paths;
  }),
  previewFile: os.previewFile.handler(async ({ context, input }) => {
    const preview = await context.workspace.previewFile(input.path);
    if (preview instanceof Error) return orpcErrors.badRequest(preview);
    return preview;
  }),
  readFile: os.readFile.handler(async ({ context, input }) => {
    context.logger.info({ event: "readWorkspaceFile", path: input.path });
    const contents = await context.workspace.readFile(input.path);
    if (contents instanceof Error) return orpcErrors.badRequest(contents);
    return contents;
  }),
  createEntry: os.createEntry.handler(async ({ context, input }) => {
    const created = await context.workspace.createEntry(input);
    if (created instanceof Error) return orpcErrors.badRequest(created);
    return created;
  }),
  moveEntry: os.moveEntry.handler(async ({ context, input }) => {
    const moved = await context.workspace.moveEntry(input);
    if (moved instanceof Error) return orpcErrors.badRequest(moved);
    return moved;
  }),
  deleteEntry: os.deleteEntry.handler(async ({ context, input }) => {
    const deleted = await context.workspace.deleteEntry(input);
    if (deleted instanceof Error) return orpcErrors.badRequest(deleted);
    return deleted;
  }),
  writeFile: os.writeFile.handler(async ({ context, input }) => {
    context.logger.info({ event: "writeWorkspaceFile", path: input.path });
    const written = await context.workspace.writeFile(
      input.path,
      input.content,
      input.expectedContent,
    );
    if (written instanceof Error) return orpcErrors.badRequest(written);
    return written;
  }),
  reconcileNote: os.reconcileNote.handler(
    async ({ context, input, signal }) => {
      const merged = await context.workspace.reconcileNote(input, signal);
      if (merged instanceof Error) return orpcErrors.badRequest(merged);
      return merged;
    },
  ),
  uploadFile: os.uploadFile.handler(async ({ context, input }) => {
    const uploaded = await context.workspace.uploadFile(input);
    if (uploaded instanceof Error) return orpcErrors.badRequest(uploaded);
    return uploaded;
  }),
  saveImage: os.saveImage.handler(async ({ context, input }) => {
    const saved = await context.workspace.saveImage(input);
    if (saved instanceof Error) return orpcErrors.badRequest(saved);
    return saved;
  }),
  events: os.events.handler(({ context, signal }) => {
    context.logger.info({ event: "subscribeWorkspaceTree" });
    return context.workspace.treeEvents.consume({ abortSignal: signal });
  }),
});
