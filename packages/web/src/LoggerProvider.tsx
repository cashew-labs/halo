import { createContext, useContext, type ReactNode } from "react";
import type { Logger } from "@get-halo/logger";

const LoggerContext = createContext<Logger>(undefined!);

export function LoggerProvider({
  logger,
  children,
}: {
  logger: Logger;
  children: ReactNode;
}) {
  return <LoggerContext value={logger}>{children}</LoggerContext>;
}

export function useLogger(): Logger {
  return useContext(LoggerContext);
}
