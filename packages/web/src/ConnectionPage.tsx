import { confirmRestart } from "./confirmRestart.js";
import { Button, Flex, P, Prose, spacing, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useCallback } from "react";
import { useAsyncData } from "./useAsyncData.js";
import { useAsyncAction } from "./useAsyncAction.js";
import type { IncompatibleServerError } from "@get-halo/client";
import type { AppInfo } from "./HostApi.js";
import { useHost } from "./HostProvider.js";
import { FullscreenPage } from "./FullscreenPage.js";

const releasesUrl = "https://github.com/cashew-labs/halo/releases/latest";

export function ConnectionPage({
  error,
  onRetry,
  workspaceUpdateAvailable = false,
}: {
  error: IncompatibleServerError;
  onRetry: () => void;
  workspaceUpdateAvailable?: boolean;
}) {
  return (
    <FullscreenPage>
      <IncompatibleConnection
        error={error}
        onRetry={onRetry}
        workspaceUpdateAvailable={workspaceUpdateAvailable}
      />
    </FullscreenPage>
  );
}

export function OfflinePage() {
  const heading = useStyles(styles.heading);
  return (
    <FullscreenPage>
      <Prose size="sm">
        <h1 className={heading}>You're offline</h1>
        <P>Halo reconnects to your workspace when you're back online.</P>
      </Prose>
    </FullscreenPage>
  );
}

export function IncompatibleConnection({
  error,
  onRetry,
  workspaceUpdateAvailable = false,
}: {
  error: IncompatibleServerError;
  onRetry?: () => void;
  workspaceUpdateAvailable?: boolean;
}) {
  const host = useHost();
  const heading = useStyles(styles.heading);
  if (
    !error.supportedProtocols.every(
      (protocol) => protocol > Number(error.clientProtocolVersion),
    )
  ) {
    return (
      <Flex column gap={12} alignItems="center">
        <Prose size="sm">
          <h1 className={heading}>Can't connect to your workspace</h1>
          {workspaceUpdateAvailable ? (
            <P>Update your workspace to reconnect to Halo.</P>
          ) : (
            <P>
              Halo's service doesn't support this version of the app. Wait for
              the service to update, then try again.
            </P>
          )}
        </Prose>
        {workspaceUpdateAvailable && <WorkspaceUpdate />}
        {onRetry && <Button onClick={onRetry}>Try again</Button>}
      </Flex>
    );
  }
  if (
    host.getAppInfo === undefined ||
    host.checkForAppUpdate === undefined ||
    host.installAppUpdate === undefined
  ) {
    return (
      <Flex column gap={12} alignItems="center">
        <Prose size="sm">
          <h1 className={heading}>Reload Halo</h1>
          <P>
            Halo needs an update to connect. Reload to get the latest version.
          </P>
        </Prose>
        <Button
          onClick={() => {
            if (confirmRestart()) window.location.reload();
          }}
        >
          Reload Halo
        </Button>
      </Flex>
    );
  }

  return (
    <DesktopUpdate
      key={JSON.stringify([
        error.clientProtocolVersion,
        error.supportedProtocols,
      ])}
      onRetry={onRetry}
    />
  );
}

export function WorkspaceUpdate() {
  const host = useHost();
  const install = useAsyncAction(async () => {
    if (!confirmRestart()) return;
    return await host.installAppUpdate?.();
  });
  return (
    <Flex column gap={4}>
      <Button
        isDisabled={install.pending || host.installAppUpdate === undefined}
        onClick={() => void install.run()}
      >
        {install.pending ? "Updating workspace…" : "Update workspace"}
      </Button>
      {install.error && <P>{install.error.message}</P>}
    </Flex>
  );
}

function DesktopUpdate({ onRetry }: { onRetry?: () => void }) {
  const host = useHost();
  const heading = useStyles(styles.heading);
  const actions = useStyles(styles.actions);
  const checkUpdate = useCallback(async () => {
    const result = await host.checkForAppUpdate?.();
    if (result instanceof Error) return result;
    return true;
  }, [host]);
  const check = useAsyncData(checkUpdate);
  const readAppInfo = useCallback(
    async () => await host.getAppInfo?.(),
    [host],
  );
  const appInfo = useAsyncData(readAppInfo, {
    enabled: check.data === true,
    refreshMs: 1_000,
  });
  const install = useAsyncAction(async () => {
    if (!confirmRestart()) return;
    return await host.installAppUpdate?.();
  });
  const openReleases = useAsyncAction(
    async () => await host.openExternalUrl?.(releasesUrl),
  );
  const update = appInfo.data?.update;
  const queryError = check.error ?? appInfo.error;
  const checking = check.fetching || update?.state === "checking";

  return (
    <Flex column gap={12} alignItems="center">
      <Prose size="sm">
        <h1 className={heading}>Update Halo</h1>
        <P>Halo needs an update to connect to your workspace.</P>
        <div role="status" aria-live="polite">
          <P>
            {updateStatusMessage({
              appInfo: appInfo.data,
              checking,
              queryError,
            })}
          </P>
        </div>
        {install.error && (
          <div role="alert">
            <P>Couldn't restart Halo to install the update. Try again.</P>
          </div>
        )}
        {openReleases.error && (
          <div role="alert">
            <P>Couldn't open the downloads page. Try again.</P>
          </div>
        )}
      </Prose>
      <div className={actions}>
        {update?.state === "downloaded" && onRetry && (
          <Button variant="quiet" onClick={onRetry}>
            Try reconnecting
          </Button>
        )}
        {(update?.state === "disabled" ||
          update?.state === "error" ||
          queryError !== undefined) &&
          host.openExternalUrl !== undefined && (
            <Button
              variant={update?.state === "disabled" ? "primary" : "quiet"}
              isDisabled={openReleases.pending}
              onClick={() => void openReleases.run()}
            >
              View downloads
            </Button>
          )}
        {update?.state === "downloaded" ? (
          <Button
            variant="primary"
            isDisabled={install.pending}
            onClick={() => void install.run()}
          >
            {install.pending ? "Restarting" : "Restart and update"}
          </Button>
        ) : update?.state === "available" || checking ? (
          <Button isDisabled>
            {update?.state === "available" ? "Downloading update" : "Checking"}
          </Button>
        ) : update?.state !== "disabled" ? (
          <Button variant="primary" onClick={check.refresh}>
            Check again
          </Button>
        ) : undefined}
      </div>
    </Flex>
  );
}

function updateStatusMessage({
  appInfo,
  checking,
  queryError,
}: {
  appInfo: AppInfo | undefined;
  checking: boolean;
  queryError: Error | undefined;
}) {
  if (queryError !== undefined) {
    return "Couldn't check for updates. Check again to retry.";
  }
  if (checking || appInfo === undefined) {
    return "Checking for updates";
  }

  switch (appInfo.update.state) {
    case "disabled":
      return "Download the latest Halo, then reopen the app.";
    case "idle":
      return "No Halo update is available yet. Check again later.";
    case "checking":
      return "Checking for updates";
    case "available":
      return "Downloading an update. Keep Halo open.";
    case "downloaded":
      return "Your update is ready. Restart Halo to finish installing it.";
    case "error":
      return "The automatic update failed. Check again to retry.";
  }
}

const styles = {
  heading: style(text({ size: "md", fontWeight: 600 })),
  actions: style({
    display: "flex",
    flexWrap: "wrap",
    justifyContent: "center",
    gap: spacing.value(3),
  }),
};
