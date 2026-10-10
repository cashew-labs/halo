import { Agentation } from "agentation";
import { Redirect, Route, Switch } from "wouter";
import type { HostApi } from "./HostApi.js";
import { HaloApp } from "./HaloApp.tsx";
import { Authentication } from "./Authentication.tsx";
import { StandaloneExtension } from "./StandaloneExtension.js";
import { ApiProvider } from "./api/ApiProvider.tsx";
import { IntegrationSetupPage } from "./IntegrationSetupPage.js";

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
          <ApiProvider>
            <HaloRoutes />
            {import.meta.env.DEV && (
              <Agentation endpoint="http://127.0.0.1:4747" />
            )}
          </ApiProvider>
        </Authentication>
      </Route>
    </Switch>
  );
}

function HaloRoutes() {
  return (
    <Switch>
      <Route path="/login">
        <Redirect to="/" replace />
      </Route>
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
