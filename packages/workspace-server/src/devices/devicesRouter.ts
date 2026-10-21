import { implement } from "@orpc/server";
import { contract } from "@get-halo/client";
import * as errore from "errore";
import { orpcErrors } from "../orpcErrors.js";
import type { DeviceService } from "./DeviceService.js";

class DeviceHostDeniedError extends errore.createTaggedError({
  name: "DeviceHostDeniedError",
  message:
    "Only the Halo desktop app can serve a device; the workspace CLI cannot",
}) {}

export type DevicesRouterContext = {
  devices: DeviceService;
  // The CLI runs on the workspace VM, so it must not pose as a computer.
  deviceHostAllowed: boolean;
};

const os = implement(contract.devices)
  .$context<DevicesRouterContext>()
  .use(async ({ context, next }) => {
    if (!context.deviceHostAllowed)
      throw orpcErrors.badRequest(new DeviceHostDeniedError());
    return await next();
  });

export const devicesRouter = os.router({
  serve: os.serve.handler(({ context, input, signal }) =>
    context.devices.serve({ device: input.device, signal }),
  ),
  respond: os.respond.handler(({ context, input }) => {
    const responded = context.devices.respond(input);
    if (responded instanceof Error) throw orpcErrors.badRequest(responded);
  }),
});
