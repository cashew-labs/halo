import { Agentation } from "agentation";
import { Redirect, Route, Switch } from "wouter";
import { HaloApp } from "./HaloApp.tsx";
import { StandaloneExtension } from "./StandaloneExtension.js";
import { ApiProvider } from "./api/ApiProvider.tsx";

/** Everything behind sign-in. Loaded lazily so public pages skip it. */
// oxlint-disable-next-line anti-slop/no-unused-exports -- HaloAppRoutes loads this through a dynamic import.
export function SignedInApp() {
  return (
    <ApiProvider>
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
      {import.meta.env.DEV && <Agentation endpoint="http://127.0.0.1:4747" />}
    </ApiProvider>
  );
}
