import { useEffect, useMemo, useState } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Key } from "react-aria-components";
import { useApi, useWorkspaceQuery } from "../api/ApiProvider.js";
import { useConnection } from "../api/ConnectionContext.js";
import { reconnectStream } from "../api/reconnectStream.js";

type Listing = { entries: string[]; error?: string };

export function useDirectoryListings(expanded: ReadonlySet<Key>) {
  const api = useApi();
  const { service, state: connection } = useConnection();
  const enabled = connection.status === "connected";
  const workspaceRoot = useWorkspaceQuery().data?.workspaceRoot;
  const queryClient = useQueryClient();
  const queryKey = useMemo(
    () => ["workspace-directories", workspaceRoot],
    [workspaceRoot],
  );
  const { data: listings = {} } = useQuery<Record<string, Listing>>({
    queryKey,
    queryFn: skipToken,
    initialData: {},
    gcTime: 0,
  });
  const [activeFolders, setActiveFolders] = useState<ReadonlySet<string>>(
    () => new Set([""]),
  );
  const paths = new Set([""]);
  for (const path of paths) {
    for (const entry of listings[path]?.entries ?? []) {
      if (entry.endsWith("/") && expanded.has(`file:${entry}`))
        paths.add(entry.slice(0, -1));
    }
  }
  if (
    paths.size !== activeFolders.size ||
    [...paths].some((path) => !activeFolders.has(path))
  ) {
    // Keep subscription identity stable for listing-only changes. React retries
    // this render before committing effects when folder membership changes.
    setActiveFolders(paths);
  }
  useEffect(() => {
    queryClient.setQueryData<Record<string, Listing>>(queryKey, (current) =>
      Object.fromEntries(
        Object.entries(current ?? {}).filter(([path]) =>
          activeFolders.has(path),
        ),
      ),
    );
    if (!enabled) return;
    const controller = new AbortController();
    reconnectStream({
      name: "Directory listings",
      signal: controller.signal,
      open: async () =>
        await api.workspace.watchDirectories(
          { paths: [...activeFolders] },
          { signal: controller.signal },
        ),
      onItem: ({ path, ...listing }) => {
        queryClient.setQueryData<Record<string, Listing>>(
          queryKey,
          (current) => ({
            ...current,
            [path]: listing,
          }),
        );
      },
      onError: (error) => service.fail(api, error),
    });
    return () => controller.abort();
  }, [api, enabled, activeFolders, service, queryClient, queryKey]);
  return {
    paths: [...activeFolders].flatMap((path) => listings[path]?.entries ?? []),
    error: [...activeFolders]
      .map((path) => listings[path]?.error)
      .find((error) => error !== undefined),
  };
}
