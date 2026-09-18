import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";
import { MauiProvider } from "maui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Route, Switch } from "wouter";
import type { Logger } from "@get-halo/logger";
import type { HostApi } from "./HostApi.js";
import { HostProvider } from "./HostProvider.js";
import { LoggerProvider } from "./LoggerProvider.js";
import { HaloApp } from "./HaloApp.tsx";
import { Authentication } from "./Authentication.tsx";
import { StandaloneExtension } from "./StandaloneExtension.js";
import { ApiProvider } from "./api/ApiProvider.tsx";
import "./css.js";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
      staleTime: Infinity,
    },
    mutations: {
      retry: false,
    },
  },
});

export function mountHaloApp(ctx: {
  root: HTMLElement;
  host: HostApi;
  logger: Logger;
}) {
  createRoot(ctx.root).render(
    <StrictMode>
      <LoggerProvider logger={ctx.logger}>
        <HostProvider host={ctx.host}>
          <MauiProvider>
            <Authentication>
              <QueryClientProvider client={queryClient}>
                <ApiProvider>
                  <HaloRoutes />
                  {import.meta.env.DEV && (
                    <Agentation endpoint="http://127.0.0.1:4747" />
                  )}
                </ApiProvider>
              </QueryClientProvider>
            </Authentication>
          </MauiProvider>
        </HostProvider>
      </LoggerProvider>
    </StrictMode>,
  );
}

function HaloRoutes() {
  return (
    <Switch>
      <Route path="/extensions/:extensionId">
        {(params) => (
          <StandaloneExtension
            extensionId={decodeURIComponent(params.extensionId)}
          />
        )}
      </Route>
      <Route>
        <HaloApp />
      </Route>
    </Switch>
  );
}
