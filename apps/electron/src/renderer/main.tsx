import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Agentation } from "agentation";
import { MauiProvider } from "maui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HostProvider } from "@get-halo/web/HostProvider";
import { App } from "./App.tsx";
import { Authentication } from "./Authentication.tsx";
import { ApiProvider } from "./api/ApiProvider.tsx";
import { electronHost } from "./ElectronHost.js";
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <HostProvider host={electronHost}>
      <MauiProvider>
        <Authentication>
          <QueryClientProvider client={queryClient}>
            <ApiProvider>
              <App />
              {import.meta.env.DEV && (
                <Agentation endpoint="http://127.0.0.1:4747" />
              )}
            </ApiProvider>
          </QueryClientProvider>
        </Authentication>
      </MauiProvider>
    </HostProvider>
  </StrictMode>,
);
