import { useQuery } from "@tanstack/react-query";
import { useApi } from "../api/ApiProvider.js";

export const appsQueryKey = ["apps"] as const;

/** The owner's apps, shared by the Share dialog, the extension tab and the sidebar. */
export function useApps(ctx: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: appsQueryKey,
    queryFn: async () => await api.apps.list(),
    enabled: ctx.enabled ?? true,
  });
}
