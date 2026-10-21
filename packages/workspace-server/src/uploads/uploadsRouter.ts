import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import { orpcErrors } from "../orpcErrors.js";
import type { UploadService } from "./UploadService.js";

export type UploadsRouterContext = {
  uploads: UploadService;
};

const os = implement(contract.uploads).$context<UploadsRouterContext>();

export const uploadsRouter = os.router({
  create: os.create.handler(async ({ context, input }) => {
    const created = await context.uploads.create(input);
    if (created instanceof Error) return orpcErrors.badRequest(created);
    return created;
  }),
  write: os.write.handler(async ({ context, input }) => {
    const written = await context.uploads.write(input);
    if (written instanceof Error) return orpcErrors.badRequest(written);
    return written;
  }),
  status: os.status.handler(({ context, input }) => {
    const status = context.uploads.status(input);
    if (status instanceof Error) return orpcErrors.badRequest(status);
    return status;
  }),
  cancel: os.cancel.handler(async ({ context, input }) => {
    const cancelled = await context.uploads.cancel(input);
    if (cancelled instanceof Error) return orpcErrors.badRequest(cancelled);
  }),
});
