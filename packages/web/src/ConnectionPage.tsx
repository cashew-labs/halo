import {
  Button,
  Flex,
  H1,
  P,
  backgroundColor,
  colors,
  radius,
  shadow,
  spacing,
} from "maui";
import { style, useStyles } from "purse-styles";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { IncompatibleServerError } from "@get-halo/client";
import type { AppInfo } from "./HostApi.js";
import { useHost } from "./HostProvider.js";

const releasesUrl =
  "https://github.com/tanishqkancharla/halo-v2/releases/latest";

type ConnectionPageProps =
  | { status: "disconnected" | "waiting" }
  | { status: "incompatible"; error: IncompatibleServerError };

export function ConnectionPage(props: ConnectionPageProps) {
  const shell = useStyles(styles.shell);
  const card = useStyles(styles.card);

  return (
    <main className={shell}>
      <section className={card}>
        {props.status === "incompatible" ? (
          <IncompatibleConnection error={props.error} />
        ) : (
          <Flex column gap={8}>
            <div>
              <H1>
                {props.status === "waiting"
                  ? "Waiting for your server"
                  : "Halo disconnected from its server"}
              </H1>
              <P>
                {props.status === "waiting"
                  ? "Halo will connect when your server is ready."
                  : "Reload Halo to reconnect."}
              </P>
            </div>
            <Button onClick={() => window.location.reload()}>
              Reload Halo
            </Button>
          </Flex>
        )}
      </section>
    </main>
  );
}

function IncompatibleConnection({ error }: { error: IncompatibleServerError }) {
  const host = useHost();
  if (
    host.getAppInfo === undefined ||
    host.checkForAppUpdate === undefined ||
    host.installAppUpdate === undefined
  ) {
    return (
      <Flex column gap={8}>
        <div>
          <H1>Reload Halo to reconnect</H1>
          <P>{protocolMismatchMessage(error)}</P>
          <P>The website may have updated while this page was open.</P>
        </div>
        <Button onClick={() => window.location.reload()}>Reload Halo</Button>
      </Flex>
    );
  }

  return (
    <DesktopUpdate
      error={error}
      getAppInfo={host.getAppInfo}
      checkForAppUpdate={host.checkForAppUpdate}
      installAppUpdate={host.installAppUpdate}
      openExternalUrl={host.openExternalUrl}
    />
  );
}

function DesktopUpdate({
  error,
  getAppInfo,
  checkForAppUpdate,
  installAppUpdate,
  openExternalUrl,
}: {
  error: IncompatibleServerError;
  getAppInfo: () => Promise<AppInfo | Error>;
  checkForAppUpdate: () => Promise<void | Error>;
  installAppUpdate: () => Promise<void | Error>;
  openExternalUrl?: (url: string) => Promise<void | Error>;
}) {
  const status = useStyles(styles.status);
  const actions = useStyles(styles.actions);
  const check = useQuery({
    queryKey: [
      "incompatible-app-update-check",
      error.clientProtocolVersion,
      error.serverProtocolVersion,
    ],
    queryFn: async () => {
      const result = await checkForAppUpdate();
      if (result instanceof Error) throw result;
      return true;
    },
    retry: false,
  });
  const appInfo = useQuery({
    queryKey: ["app-info"],
    queryFn: async () => {
      const result = await getAppInfo();
      if (result instanceof Error) throw result;
      return result;
    },
    enabled: check.isSuccess,
    refetchInterval: 1_000,
    retry: false,
  });
  const install = useMutation({
    mutationFn: async () => {
      const result = await installAppUpdate();
      if (result instanceof Error) throw result;
    },
  });
  const openReleases = useMutation({
    mutationFn: async () => {
      if (openExternalUrl === undefined) return;
      const result = await openExternalUrl(releasesUrl);
      if (result instanceof Error) throw result;
    },
  });
  const update = appInfo.data?.update;
  const queryError = check.error ?? appInfo.error;
  const actionError = install.error ?? openReleases.error;
  const checking = check.isFetching || update?.state === "checking";

  return (
    <Flex column gap={8}>
      <div>
        <H1>Update Halo to reconnect</H1>
        <P>{protocolMismatchMessage(error)}</P>
      </div>
      <div className={status} role="status" aria-live="polite">
        <P>
          {updateStatusMessage({
            appInfo: appInfo.data,
            checking,
            queryError,
          })}
        </P>
      </div>
      {actionError && (
        <div role="alert">
          <P>Halo could not complete that action. Try again.</P>
        </div>
      )}
      <div className={actions}>
        {update?.state === "downloaded" ? (
          <Button
            variant="primary"
            disabled={install.isPending}
            onClick={() => install.mutate()}
          >
            {install.isPending
              ? "Restarting…"
              : `Restart and install Halo ${update.version}`}
          </Button>
        ) : update?.state === "available" || checking ? (
          <Button disabled>
            {update?.state === "available"
              ? "Downloading update…"
              : "Checking…"}
          </Button>
        ) : update?.state !== "disabled" ? (
          <Button onClick={() => void check.refetch()}>Check again</Button>
        ) : undefined}
        {(update?.state === "disabled" ||
          update?.state === "error" ||
          queryError !== null) &&
          openExternalUrl !== undefined && (
            <Button
              variant="quiet"
              disabled={openReleases.isPending}
              onClick={() => openReleases.mutate()}
            >
              View Halo downloads
            </Button>
          )}
      </div>
    </Flex>
  );
}

function protocolMismatchMessage(error: IncompatibleServerError) {
  return `This app uses protocol ${error.clientProtocolVersion}, while your server uses protocol ${error.serverProtocolVersion}.`;
}

function updateStatusMessage({
  appInfo,
  checking,
  queryError,
}: {
  appInfo: AppInfo | undefined;
  checking: boolean;
  queryError: Error | null;
}) {
  if (queryError !== null) {
    return "Halo could not check for updates. Check your internet connection, then try again.";
  }
  if (checking || appInfo === undefined) {
    return "Checking for a compatible Halo update…";
  }

  switch (appInfo.update.state) {
    case "disabled":
      return `${appInfo.update.reason}. Install the latest Halo release manually, then reopen the app.`;
    case "idle":
      return `Halo ${appInfo.version} is the newest published version, but it cannot use this server yet. A compatible update is not available yet; check again shortly.`;
    case "checking":
      return "Checking for a compatible Halo update…";
    case "available":
      return "A compatible update is downloading automatically. Keep Halo open; installation will be available when the download finishes.";
    case "downloaded":
      return `Halo ${appInfo.update.version} is ready. Restart now to install it and reconnect.`;
    case "error":
      return "Halo could not check for updates. Check your internet connection, then try again.";
  }
}

const styles = {
  shell: style(spacing.padding({ all: 12 }), {
    display: "grid",
    placeItems: "center",
    minHeight: "100vh",
    backgroundColor: colors.gray[2],
  }),
  card: style(shadow.subtle, radius.lg, spacing.padding({ all: 12 }), {
    width: "min(100%, 440px)",
    minWidth: 0,
    backgroundColor: backgroundColor.element,
  }),
  status: style(radius.md, spacing.padding({ all: 6 }), {
    backgroundColor: colors.gray[3],
  }),
  actions: style({
    display: "flex",
    flexWrap: "wrap",
    gap: spacing.value(3),
  }),
};
