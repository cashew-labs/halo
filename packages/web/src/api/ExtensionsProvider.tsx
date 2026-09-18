import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import type { ExtensionSummary, HaloClient } from "@get-halo/client";
import { reconnectStream } from "./reconnectStream.js";

type ExtensionsState = {
  data: ExtensionSummary[] | undefined;
  error: Error | undefined;
};

const empty: ExtensionsState = { data: undefined, error: undefined };
const ExtensionsContext = createContext<ExtensionsState>(empty);

export function ExtensionsProvider({
  api,
  children,
}: {
  api: HaloClient;
  children: ReactNode;
}) {
  const [state, setState] = useState<ExtensionsState & { api: HaloClient }>({
    ...empty,
    api,
  });
  useEffect(() => {
    const controller = new AbortController();
    reconnectStream({
      name: "Extensions",
      signal: controller.signal,
      open: async () =>
        await api.extensions.watch(undefined, { signal: controller.signal }),
      onItem: (data) => setState({ api, data, error: undefined }),
      onError: (error) =>
        setState((current) => ({
          api,
          data: current.api === api ? current.data : undefined,
          error,
        })),
    });
    return () => controller.abort();
  }, [api]);

  return (
    <ExtensionsContext value={state.api === api ? state : empty}>
      {children}
    </ExtensionsContext>
  );
}

export function useExtensions() {
  return useContext(ExtensionsContext);
}
