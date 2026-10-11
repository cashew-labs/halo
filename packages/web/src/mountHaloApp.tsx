import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MauiProvider } from "maui";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { HostApi } from "./HostApi.js";
import { HostProvider } from "./HostProvider.js";
import { HaloAppRoutes } from "./HaloAppRoutes.tsx";
import "./css.js";
// Document shell (html/body/#root) must apply before React; purse-styles injects in layout effect.
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

export function mountHaloApp(root: HTMLElement, host: HostApi) {
  createRoot(root).render(
    <StrictMode>
      <HostProvider host={host}>
        <MauiProvider>
          <QueryClientProvider client={queryClient}>
            <HaloAppRoutes host={host} />
          </QueryClientProvider>
        </MauiProvider>
      </HostProvider>
    </StrictMode>,
  );
}
