import { useEffect, useState, type ReactNode } from "react";
import {
  createWorkspaceRemote,
  haloSchemaToTandemSchema,
  workspaceSchema,
  type HaloClient,
} from "@get-halo/client";
import { TandemClient } from "@tanishqkancharla/tandem-core";
import { TandemClientProvider } from "@tanishqkancharla/tandem-react";
import * as errore from "errore";
import { useConnection } from "../api/ConnectionContext.js";

class WorkspaceDataError extends errore.createTaggedError({
  name: "WorkspaceDataError",
  message: "Could not synchronize workspace data",
}) {}

export function WorkspaceDataProvider({
  api,
  children,
}: {
  api: HaloClient;
  children: ReactNode;
}) {
  const { service, state } = useConnection();
  const enabled =
    state.status === "synchronizing" || state.status === "connected";
  // A local replica is available even before the network connects.
  const [client, setClient] = useState(
    () =>
      new TandemClient({
        ...haloSchemaToTandemSchema(workspaceSchema),
        autoConnect: false,
      }),
  );
  // Retain the last replica and mounted panes during outages; fresh replicas
  // avoid reusing process-local server cookies after a restart.
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const db = new TandemClient({
      ...haloSchemaToTandemSchema(workspaceSchema),
      remote: createWorkspaceRemote({
        api,
        signal: controller.signal,
        onDisconnect: (error) => service.fail(api, error),
      }),
      autoConnect: false,
    });
    const connected = (async () => {
      await db.ready;
      if (controller.signal.aborted) return;
      setClient(db);
      await db.connect();
    })().catch((cause) => {
      if (!controller.signal.aborted)
        service.fail(api, new WorkspaceDataError({ cause }));
    });
    return () => {
      controller.abort();
      void connected
        .then(async () => await db.disconnect())
        .catch(console.error);
    };
  }, [api, enabled, service]);
  return (
    <TandemClientProvider client={client}>{children}</TandemClientProvider>
  );
}
