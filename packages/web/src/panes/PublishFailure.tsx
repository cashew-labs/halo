import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AppSummary } from "@get-halo/client";
import { flex, radius, spacing, text } from "maui";
import { WarningTriangle } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";

export const appsQueryKey = ["apps"] as const;

/** The owner's apps, shared by the Share dialog, the extension tab and the sidebar. */
export function useApps(ctx: { enabled?: boolean } = {}) {
  const api = useApi();
  return useQuery({
    queryKey: appsQueryKey,
    queryFn: async () => await api.apps.list(),
    enabled: ctx.enabled ?? true,
  });
}

/**
 * Finishing or abandoning a publish that stopped part-way. Publishing again
 * keeps the saved access; keeping it local restarts the local extension.
 */
export function usePublishRecovery(app: AppSummary | undefined) {
  const api = useApi();
  const queryClient = useQueryClient();
  const refresh = async () =>
    await queryClient.invalidateQueries({ queryKey: appsQueryKey });
  const publishAgain = useMutation({
    mutationFn: async (target: AppSummary) =>
      await api.apps.publish({
        extensionId: target.extensionId,
        access: { visibility: target.visibility, members: target.members },
      }),
    onSettled: refresh,
  });
  // Some failures are recorded on the app and shown by the notice; others
  // (a lost connection, or an app the control plane abandoned) are not.
  const recorded =
    app?.publishFailure !== undefined &&
    app.publishFailure.failedAt !==
      publishAgain.variables?.publishFailure?.failedAt;
  const keepLocal = useMutation({
    mutationFn: async (target: AppSummary) =>
      await api.apps.cancel({ appId: target.appId }),
    onSettled: refresh,
  });
  const failed = app !== undefined && app.stage !== "live";
  return {
    pending: publishAgain.isPending || keepLocal.isPending,
    publishing: publishAgain.isPending,
    error:
      keepLocal.error ??
      (recorded || publishAgain.isPending ? undefined : publishAgain.error) ??
      undefined,
    publishAgain: () => {
      if (failed) publishAgain.mutate(app);
    },
    keepLocal: () => {
      if (failed) keepLocal.mutate(app);
    },
  };
}

/** Why the last publish stopped, in the owner's words. */
export function PublishFailureNotice({
  displayName,
  failure,
}: {
  displayName: string;
  failure: NonNullable<AppSummary["publishFailure"]>;
}) {
  const box = useStyles(styles.box);
  const title = useStyles(styles.title);
  const body = useStyles(styles.body);
  const time = new Date(failure.failedAt).toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit",
  });
  return (
    <div className={box} role="alert">
      <WarningTriangle size="sm" aria-hidden />
      <div>
        <p className={title}>{displayName} failed to publish.</p>
        <p className={body}>
          {failure.message} Your app and its data are safe. Publish again to try
          once more, or keep it in this workspace. Last attempt at {time}.
        </p>
      </div>
    </div>
  );
}

const styles = {
  box: style(
    flex({ gap: 3, alignItems: "start" }),
    radius.md,
    spacing.padding({ all: 3 }),
    {
      color: "light-dark(#7a2e0e, #ffb38a)",
      backgroundColor: "light-dark(#fff4ed, #2b1a12)",
      border: "1px solid light-dark(#f9dbaf, #5a3420)",
      "& > svg": { flex: "0 0 auto", marginTop: "2px" },
    },
  ),
  title: style(text({ size: "sm", fontWeight: 600 }), { margin: 0 }),
  body: style(text({ size: "sm" }), { margin: "2px 0 0" }),
};
