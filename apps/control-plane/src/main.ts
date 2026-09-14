import { config } from "@get-halo/config/controlPlane";
import * as errore from "errore";
import { ControlPlane } from "./server/ControlPlane.js";

async function run() {
  const stopping = new Promise<void>((stop) => {
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    process.once("disconnect", stop);
    process.on("message", (message) => {
      if (message === "shutdown") stop();
    });
  });
  if (config instanceof Error) return config;
  const plane = await ControlPlane.start(config.server);
  if (plane instanceof Error) return plane;
  await using cleanup = new errore.AsyncDisposableStack();
  cleanup.defer(async () => {
    const closed = await plane.close();
    if (closed instanceof Error) console.error(closed);
  });
  console.log(`Control plane listening at ${plane.origin}`);
  if (process.connected) process.send?.({ origin: plane.origin });
  await stopping;
}

// oxlint-disable-next-line typescript/no-floating-promises -- This entry point owns the process lifetime and exits after service cleanup.
run().then((result) => {
  if (result instanceof Error) console.error(result);
  process.exit(result instanceof Error ? 1 : 0);
});
