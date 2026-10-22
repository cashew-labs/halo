import { lazy, Suspense, useEffect } from "react";
import { Route, Switch, useRoute } from "wouter";
import type { HostApi } from "./HostApi.js";
import { Authentication } from "./Authentication.tsx";
import { IntegrationSetupPage } from "./IntegrationSetupPage.js";
import { LoadingPage } from "./LoadingPage.tsx";

const SignedInApp = lazy(async () => ({
  default: (await import("./SignedInApp.tsx")).SignedInApp,
}));

export function HaloAppRoutes({ host }: { host: HostApi }) {
  const [extensionRoute, extensionParams] = useRoute(
    "/extensions/:extensionId",
  );
  const extensionId = extensionRoute
    ? encodeURIComponent(decodeURIComponent(extensionParams.extensionId))
    : undefined;
  const documentExtensionId = document.querySelector<HTMLMetaElement>(
    'meta[name="halo-extension-id"]',
  )?.content;
  // Electron has neither marker nor manifest. Browser documents own one app
  // identity because WebKit retains the first manifest it processes.
  const reload =
    (documentExtensionId !== undefined ||
      document.querySelector('link[rel="manifest"]') !== null) &&
    extensionId !== documentExtensionId;
  useEffect(() => {
    if (reload) window.location.reload();
  }, [reload]);
  if (reload) return <LoadingPage progressLabel="Loading Halo" />;

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
