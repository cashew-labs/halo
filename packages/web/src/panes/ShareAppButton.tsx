import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import * as errore from "errore";
import type { AppAccessList, AppSummary } from "@get-halo/client";
import {
  Button,
  RadioOption,
  RadioOptionGroup,
  TextField,
  Tooltip,
  backgroundColor,
  flex,
  radius,
  shadow,
  spacing,
  text,
} from "maui";
import { Share } from "maui/icons";
import { style, useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";
import { useExtensions } from "../api/WorkspaceUpdatesProvider.js";
import {
  PublishFailureNotice,
  appsQueryKey,
  useApps,
  usePublishRecovery,
} from "./PublishFailure.js";
import { paneStyles } from "./paneStyles.js";

class ShareLinkCopyError extends errore.createTaggedError({
  name: "ShareLinkCopyError",
  message: "Could not copy the link",
}) {}

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Opens sharing for one extension: publish, access, invited people, link. */
export function ShareAppButton({ extensionId }: { extensionId: string }) {
  const className = useStyles(paneStyles.add);
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Share" placement="bottom">
        <Button
          variant="quiet"
          className={className}
          aria-label="Share"
          onPress={() => setOpen(true)}
        >
          <Share size="sm" />
        </Button>
      </Tooltip>
      {open && (
        <ShareAppDialog
          extensionId={extensionId}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ShareAppDialog({
  extensionId,
  onClose,
}: {
  extensionId: string;
  onClose(): void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
  const apps = useApps();
  const app = apps.data?.find((entry) => entry.extensionId === extensionId);
  const displayName =
    useExtensions().data?.find((entry) => entry.id === extensionId)
      ?.displayName ??
    app?.displayName ??
    extensionId;
  const recovery = usePublishRecovery(app);
  const [access, setAccess] = useState<AppAccessList | undefined>();
  const current: AppAccessList =
    access ??
    (app === undefined
      ? { visibility: "public", members: [] }
      : { visibility: app.visibility, members: app.members });
  const [email, setEmail] = useState("");
  const [copied, setCopied] = useState(false);
  const save = useMutation({
    mutationFn: async (input: {
      access: AppAccessList;
      published?: boolean;
      // The failure already on record, to tell a new one from it.
      failedAt?: number;
    }): Promise<AppSummary> =>
      app === undefined || app.stage !== "live"
        ? await api.apps.publish({ extensionId, access: input.access })
        : await api.apps.update({
            appId: app.appId,
            access: input.access,
            published: input.published,
          }),
    onSuccess: (saved) => {
      setAccess(undefined);
      queryClient.setQueryData<AppSummary[]>(appsQueryKey, (previous) => [
        ...(previous ?? []).filter((entry) => entry.appId !== saved.appId),
        saved,
      ]);
    },
    // A failed publish is recorded on the app; reload it to show why.
    onError: () =>
      void queryClient.invalidateQueries({ queryKey: appsQueryKey }),
  });
  const copy = useMutation({
    mutationFn: async (url: string) => {
      const copiedLink = await navigator.clipboard
        .writeText(url)
        .catch((cause) => new ShareLinkCopyError({ cause }));
      if (copiedLink instanceof Error) throw copiedLink;
      setCopied(true);
    },
  });
  const overlay = useStyles(styles.overlay);
  const modal = useStyles(styles.modal);
  const body = useStyles(styles.body);
  const heading = useStyles(styles.heading);
  const detail = useStyles(styles.detail);
  const row = useStyles(styles.row);
  const people = useStyles(styles.people);
  const person = useStyles(styles.person);
  const link = useStyles(styles.link);
  const buttons = useStyles(styles.buttons);
  const errorClass = useStyles(styles.error);
  const live = app?.stage === "live";
  const shared = live && app.published;
  const changed =
    access !== undefined &&
    (app === undefined ||
      access.visibility !== app.visibility ||
      access.members.join() !== app.members.join());
  const addPerson = () => {
    const normalized = email.trim().toLowerCase();
    if (!emailPattern.test(normalized)) return;
    setAccess({
      visibility: "invited",
      members: [...new Set([...current.members, normalized])],
    });
    setEmail("");
  };
  // An invited app needs at least one person besides the owner.
  // A cached list may be stale while it refetches; never change access from it.
  const changing = save.isPending || apps.isFetching;
  const emptyInvite =
    current.visibility === "invited" && current.members.length === 0;
  const failure = live ? undefined : app?.publishFailure;
  // A recorded failure replaces the raw publish error, which names host
  // details; while the list reloads after a failure, neither is shown yet.
  const recorded =
    failure !== undefined && failure.failedAt !== save.variables?.failedAt;
  const saveError = recorded || apps.isFetching ? undefined : save.error;
  const error = saveError ?? recovery.error ?? apps.error ?? copy.error;
  const stalled = app !== undefined && !live;
  const busy = changing || recovery.pending;

  return (
    <ModalOverlay
      isOpen
      // Publishing can take minutes; its result is shown in this dialog.
      isDismissable={!save.isPending}
      isKeyboardDismissDisabled={save.isPending}
      onOpenChange={(isOpen) => {
        if (!isOpen) onClose();
      }}
      className={overlay}
    >
      <Modal className={modal}>
        <Dialog aria-label="Share app">
          <div className={body}>
            <h2 className={heading}>Share app</h2>
            {apps.isPending && <p role="status">Loading…</p>}
            {/* Without the app list, publishing could overwrite existing access. */}
            {apps.isSuccess && (
              <>
                {!live && (
                  <p className={detail}>
                    Sharing moves this app and its data to its own server. You
                    and the people you share with use the same live app, and you
                    keep editing it from Halo.
                  </p>
                )}
                <RadioOptionGroup
                  label="Who can open it"
                  value={current.visibility}
                  onChange={(value) =>
                    setAccess({
                      visibility: value === "invited" ? "invited" : "public",
                      members: current.members,
                    })
                  }
                  isDisabled={save.isPending}
                >
                  <RadioOption value="public">Anyone with the link</RadioOption>
                  <RadioOption value="invited">Invited Halo users</RadioOption>
                </RadioOptionGroup>
                {current.visibility === "invited" && (
                  <>
                    <form
                      className={row}
                      onSubmit={(event) => {
                        event.preventDefault();
                        addPerson();
                      }}
                    >
                      <TextField
                        aria-label="Email address to invite"
                        placeholder="name@example.com"
                        value={email}
                        onChange={setEmail}
                        isDisabled={save.isPending}
                      />
                      <Button
                        type="submit"
                        isDisabled={
                          save.isPending ||
                          !emailPattern.test(email.trim().toLowerCase())
                        }
                      >
                        Invite
                      </Button>
                    </form>
                    {current.members.length === 0 ? (
                      <p className={detail}>Nobody is invited yet.</p>
                    ) : (
                      <ul className={people} aria-label="Invited people">
                        {current.members.map((member) => (
                          <li key={member} className={person}>
                            <span>{member}</span>
                            <Button
                              variant="quiet"
                              aria-label={`Remove ${member}`}
                              isDisabled={save.isPending}
                              onPress={() =>
                                setAccess({
                                  visibility: "invited",
                                  members: current.members.filter(
                                    (item) => item !== member,
                                  ),
                                })
                              }
                            >
                              Remove
                            </Button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
                <p className={detail}>
                  The app decides what visitors can see, change, ask its
                  assistant, and which of your connected tools it may use.
                </p>
                {live && (
                  <div className={row}>
                    <a
                      className={link}
                      href={app.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {app.url}
                    </a>
                    <Button
                      variant="quiet"
                      isDisabled={!shared}
                      onPress={() => copy.mutate(app.url)}
                    >
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                  </div>
                )}
                {live && !app.published && (
                  <p className={detail}>
                    Not shared. Only you can open this app.
                  </p>
                )}
                {save.isPending && (
                  <p className={detail} role="status">
                    Publishing {displayName}. This can take a minute.
                  </p>
                )}
                {!save.isPending && failure !== undefined && (
                  <PublishFailureNotice
                    displayName={displayName}
                    failure={failure}
                  />
                )}
                {!save.isPending && stalled && failure === undefined && (
                  <p className={detail} role="status">
                    Publishing is not finished. Publish again to continue.
                  </p>
                )}
              </>
            )}
            {error && (
              <p className={errorClass} role="alert">
                {error.message}
              </p>
            )}
            <div className={buttons}>
              {apps.isError && (
                <Button
                  isDisabled={apps.isFetching}
                  onPress={() => void apps.refetch()}
                >
                  Retry
                </Button>
              )}
              {live && (
                <Button
                  variant="quiet"
                  isDisabled={
                    changing ||
                    (!app.published &&
                      app.visibility === "invited" &&
                      app.members.length === 0)
                  }
                  // Sharing on or off keeps the saved access; unsaved edits
                  // are applied only by Save.
                  onPress={() =>
                    save.mutate({
                      access: {
                        visibility: app.visibility,
                        members: app.members,
                      },
                      published: !app.published,
                    })
                  }
                >
                  {app.published ? "Stop sharing" : "Share again"}
                </Button>
              )}
              {stalled && !save.isPending && (
                <Button
                  variant="quiet"
                  isDisabled={busy}
                  onPress={recovery.keepLocal}
                >
                  Keep it local
                </Button>
              )}
              {apps.isSuccess && !live && (
                <Button
                  isDisabled={busy || emptyInvite}
                  onPress={() =>
                    save.mutate({
                      access: current,
                      failedAt: failure?.failedAt,
                    })
                  }
                >
                  {save.isPending
                    ? "Publishing…"
                    : stalled
                      ? "Publish again"
                      : "Publish"}
                </Button>
              )}
              {live && changed && (
                <Button
                  isDisabled={changing || emptyInvite}
                  onPress={() => save.mutate({ access: current })}
                >
                  Save
                </Button>
              )}
              <Button
                variant="quiet"
                isDisabled={save.isPending}
                onPress={onClose}
              >
                Done
              </Button>
            </div>
          </div>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}

const styles = {
  overlay: style({
    position: "fixed",
    inset: 0,
    zIndex: 100,
    backgroundColor: "rgba(0, 0, 0, 0.35)",
    display: "grid",
    placeItems: "center",
    padding: "16px",
  }),
  modal: style(shadow.strong, radius.lg, spacing.padding({ all: 8 }), {
    width: "min(440px, 100%)",
    maxHeight: "calc(100dvh - 32px)",
    overflowY: "auto",
    backgroundColor: backgroundColor.app,
    "& [role='dialog']": { outline: "none" },
  }),
  body: style(flex({ direction: "column", gap: 4 })),
  heading: style(text({ size: "md", fontWeight: 600 }), { margin: 0 }),
  detail: style(text({ size: "sm", color: "lowContrast" }), { margin: 0 }),
  // The field or link takes the remaining width; its button keeps its own.
  row: style(flex({ alignItems: "center", gap: 3 }), {
    "& > :first-child": { flex: "1 1 auto", minWidth: 0 },
    "& > :not(:first-child)": { flex: "0 0 auto" },
  }),
  people: style(flex({ direction: "column", gap: 1 }), {
    listStyle: "none",
    margin: 0,
    padding: 0,
  }),
  person: style(
    text({ size: "sm" }),
    flex({ alignItems: "center", justifyContent: "between", gap: 3 }),
    { overflowWrap: "anywhere" },
  ),
  link: style(text({ size: "sm" }), {
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  }),
  buttons: style(flex({ justifyContent: "end", gap: 3, wrap: true }), {
    "& button": { transition: "none" },
  }),
  error: style(text({ size: "sm" }), {
    color: "light-dark(#b42318, #ff9592)",
    overflowWrap: "anywhere",
  }),
};
