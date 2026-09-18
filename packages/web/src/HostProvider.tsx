import { useExternalLinks } from "./useExternalLinks.js";
import { createContext, useContext, type ReactNode } from "react";
import type { HostApi } from "./HostApi.js";

const HostContext = createContext<HostApi>(undefined!);

export function HostProvider({
  host,
  children,
}: {
  host: HostApi;
  children: ReactNode;
}) {
  useExternalLinks(host);
  return <HostContext value={host}>{children}</HostContext>;
}

export function useHost(): HostApi {
  return useContext(HostContext);
}
