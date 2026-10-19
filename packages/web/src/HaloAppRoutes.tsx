import { lazy, Suspense } from "react";
import { Route, Switch } from "wouter";
import type { HostApi } from "./HostApi.js";
import { Authentication } from "./Authentication.tsx";
import { IntegrationSetupPage } from "./IntegrationSetupPage.js";
import { LoadingPage } from "./LoadingPage.tsx";

const SignedInApp = lazy(async () => ({
  default: (await import("./SignedInApp.tsx")).SignedInApp,
}));

export function HaloAppRoutes({ host }: { host: HostApi }) {
  return (
    <Switch>
      {/* Halo's handoff link authorizes this browser without a sign-in. */}
      {host.integrationSetup !== undefined && (
        <Route path="/integrations/setup/:setupId">
          {(params) => (
            <IntegrationSetupPage
              setupId={params.setupId}
              api={host.integrationSetup!}
            />
          )}
        </Route>
      )}
      <Route>
        <Authentication>
          <Suspense fallback={<LoadingPage progressLabel="Loading Halo" />}>
            <SignedInApp />
          </Suspense>
        </Authentication>
      </Route>
    </Switch>
  );
}
