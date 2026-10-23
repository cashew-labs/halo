import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { DialogTrigger } from "react-aria-components";
import type { AppAccessList, AppSummary } from "@get-halo/client";
import { Button, Dialog, backgroundColor } from "maui";
import { Users } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useAccount } from "../Authentication.js";
import { useHost } from "../HostProvider.js";
import { useApi } from "../api/ApiProvider.js";
import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";
import {
  ShareAppForm,
  type ShareDraft,
  type SharePhase,
} from "./ShareAppForm.js";
import { appsQueryKey, useApps } from "./useApps.js";

/** Draft access changes are applied only by the dialog's primary action. */
export function ShareAppButton({ extensionId }: { extensionId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button variant="quiet">
        <Users size="sm" />
        Share
      </Button>
      <ShareAppDialog
        extensionId={extensionId}
        open={open}
        onOpenChange={setOpen}
      />
    </DialogTrigger>
  );
}

function ShareAppDialog({
  extensionId,
  open,
  onOpenChange,
}: {
  extensionId: string;
  open: boolean;
  onOpenChange(open: boolean): void;
}) {
  const api = useApi();
  const host = useHost();
  const { session } = useAccount();
  const queryClient = useQueryClient();
  const apps = useApps({ enabled: open });
  const app = apps.data?.find((entry) => entry.extensionId === extensionId);
  const extension = useExtensions().data?.find(
    (entry) => entry.id === extensionId,
  );
  const displayName = extension?.displayName ?? app?.displayName ?? extensionId;
  const hosted = app?.stage === "live";
  const save = useMutation({
    mutationFn: async ({
      access,
    }: {
      access: AppAccessList;
      failedAt?: number;
    }) =>
      hosted
        ? await api.apps.update({
            appId: app.appId,
            access,
            // Removing external access leaves the server running.
            published:
              access.visibility === "public" || access.members.length > 0,
          })
        : await api.apps.publish({ extensionId, access }),
    onSuccess: (saved) => {
      queryClient.setQueryData<AppSummary[]>(appsQueryKey, (previous) => [
        ...(previous ?? []).filter((entry) => entry.appId !== saved.appId),
        saved,
      ]);
    },
    onError: async (error) => {
      console.warn("Could not save extension sharing", error);
      await queryClient.invalidateQueries({ queryKey: appsQueryKey });
    },
  });
  // Refetch on opening; cached permissions must not be editable until checked.
  const phase: SharePhase = save.isPending
    ? hosted
      ? "saving"
      : "hosting"
    : apps.isFetching || apps.isPending
      ? "loading"
      : apps.isError
        ? "load-error"
        : app?.stage === "removing"
          ? "removing"
          : !hosted && app?.stage === "publishing"
            ? "host-error"
            : save.isError
              ? hosted
                ? "save-error"
                : "host-error"
              : "idle";
  const modal = useStyles(styles.modal);
  const failure = app?.stage === "publishing" ? app.publishFailure : undefined;
  // A retry must not reuse the reason recorded for its previous attempt.
  const hostingFailure =
    failure?.failedAt !== save.variables?.failedAt
      ? failure?.message
      : undefined;
  // An unfinished publish retains the intended audience for Retry.
  const hasAccess = app?.published || app?.stage === "publishing";
  const access = hasAccess ? app.visibility : "invited";
  const members = hasAccess ? app.members : [];
  const baseline = JSON.stringify([apps.data !== undefined, access, members]);
  const draft: ShareDraft = {
    access: access === "public" ? "public" : "restricted",
    people: members,
  };
  return (
    <Dialog
      isOpen={open}
      isDismissable={!save.isPending}
      isKeyboardDismissDisabled={save.isPending}
      onOpenChange={(next) => {
        if (save.isPending) return;
        onOpenChange(next);
        if (!next) save.reset();
      }}
      className={modal}
      aria-label={`Share ${displayName}`}
    >
      <ShareAppForm
        key={baseline}
        draft={draft}
        hosted={hosted}
        phase={phase}
        hostingFailure={hostingFailure}
        displayName={displayName}
        owner={session.user}
        link={app?.url ?? host.getExtensionUrl(extensionId)}
        frameUrl={
          extension !== undefined &&
          extension.remote === undefined &&
          extension.publishing === undefined
            ? host.getExtensionFrameUrl(extensionId)
            : undefined
        }
        embedded
        onClose={() => {
          onOpenChange(false);
          save.reset();
        }}
        onSave={(next) => {
          if (
            phase === "idle" ||
            phase === "host-error" ||
            phase === "save-error"
          )
            save.mutate({ access: next, failedAt: failure?.failedAt });
        }}
        onRetry={() => void apps.refetch()}
      />
    </Dialog>
  );
}

const styles = {
  modal: style({
    "&&": {
      padding: 0,
      overflow: "visible",
      backgroundColor: backgroundColor.element,
    },
    "& [role='dialog']": { gap: 0 },
  }),
};
