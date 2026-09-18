import { KeyboardShortcuts } from "./KeyboardShortcuts.js";
import { spacing, text } from "maui";
import { style, useStyles } from "purse-styles";
import { skipToken, useQuery } from "@tanstack/react-query";
import { Redirect, Route, Router } from "wouter";
import { useHashLocation } from "wouter/use-hash-location";
import type { SessionSummary } from "@get-halo/client";
import type { AppInfo } from "./HostApi.js";
import { useHost } from "./HostProvider.js";
import { LoadingPage } from "./LoadingPage.tsx";
import { WorkspaceLayout } from "./WorkspaceLayout.js";
import { ConnectionPage } from "./ConnectionPage.tsx";
import { useSessionsQuery, useWorkspaceQuery } from "./api/ApiProvider.tsx";

export function HaloApp() {
  const workspaceQuery = useWorkspaceQuery();
  const workspace = workspaceQuery.data;
  const sessionsQuery = useSessionsQuery(workspace);
  const appInfoQuery = useAppInfoQuery();
  const sessions = sessionsQuery.data === undefined ? [] : sessionsQuery.data;

  if (workspaceQuery.isError) return <ConnectionPage status="disconnected" />;

  if (workspaceQuery.isPending || workspace === undefined) {
    return <LoadingPage />;
  }

  if (!sessionsQuery.isFetched) {
    return <LoadingPage />;
  }

  return (
    <WorkspaceShell
      sessions={sessions}
      alertMessage={
        sessionsQuery.error ? String(sessionsQuery.error) : undefined
      }
      appInfo={appInfoQuery.data}
    />
  );
}

function useAppInfoQuery() {
  const host = useHost();
  const getAppInfo = host.getAppInfo?.bind(host);
  return useQuery({
    queryKey: ["app-info"],
    queryFn:
      getAppInfo === undefined
        ? skipToken
        : async () => {
            const appInfo = await getAppInfo();
            if (appInfo instanceof Error) throw appInfo;
            return appInfo;
          },
    refetchInterval: 5_000,
  });
}

function WorkspaceShell({
  sessions,
  alertMessage,
  appInfo,
}: {
  sessions: SessionSummary[];
  alertMessage?: string;
  appInfo?: AppInfo;
}) {
  const readyApp = useStyles(styles.readyApp);
  const errorClassName = useStyles(styles.error);

  return (
    <div className={readyApp}>
      {alertMessage && (
        <div className={errorClassName} role="alert">
          {alertMessage}
        </div>
      )}
      {/* oxlint-disable-next-line react/hooks -- Wouter calls the location hook supplied to Router. */}
      <Router hook={useHashLocation}>
        <KeyboardShortcuts />
        <Route path="/">
          <Redirect to={initialHostPath(sessions)} replace />
        </Route>
        <WorkspaceLayout sessions={sessions} appInfo={appInfo} />
      </Router>
    </div>
  );
}

function initialHostPath(sessions: SessionSummary[]) {
  const first = sessions[0];
  if (first !== undefined) return `/sessions/${first.sessionId}`;
  return `/draft/${crypto.randomUUID()}`;
}

const styles = {
  readyApp: style({
    position: "relative",
    width: "100%",
    height: "100dvh",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  }),
  error: style(
    text({ size: "xs", fontWeight: 500, color: "highContrast" }),
    spacing.padding({ all: 4 }),
    {
      position: "relative",
      zIndex: 1,
      color: "light-dark(#b42318, #ff9592)",
      backgroundColor: "light-dark(#ffebe9, #3b1219)",
    },
  ),
};
