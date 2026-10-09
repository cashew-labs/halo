import { useState } from "react";
import { Dialog, Modal, ModalOverlay } from "react-aria-components";
import { useMutation, useQuery } from "@tanstack/react-query";
import type { Automation, AutomationActivation } from "@get-halo/client";
import { Button, Select, SelectItem, TextField } from "maui";
import { useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";
import { automationStyles as styles } from "./automationStyles.js";

export function AutomationEditor({
  automation,
  onClose,
  onSaved,
}: {
  automation?: Automation;
  onClose(): void;
  onSaved(automation: Automation): void;
}) {
  const api = useApi();
  const initial = automation?.activation;
  const gmail =
    initial?.type === "trigger" && initial.trigger.type === "gmail"
      ? initial.trigger
      : undefined;
  const [name, setName] = useState(automation?.name ?? "");
  const [type, setType] = useState<"routine" | "trigger">(
    initial?.type ?? "routine",
  );
  const [kind, setKind] = useState<"webhook" | "gmail">(
    initial?.type === "trigger" ? initial.trigger.type : "webhook",
  );
  const [cron, setCron] = useState(
    initial?.type === "routine" ? initial.schedule.cron : "0 9 * * *",
  );
  const [timezone, setTimezone] = useState(
    initial?.type === "routine"
      ? initial.schedule.timezone
      : new Intl.DateTimeFormat().resolvedOptions().timeZone,
  );
  const [connectionAddress, setConnectionAddress] = useState(
    gmail?.connectionAddress ?? "",
  );
  const [from, setFrom] = useState(gmail?.from ?? "");
  const [subject, setSubject] = useState(gmail?.subjectContains ?? "");
  const [enabled, setEnabled] = useState(automation?.enabled ?? true);
  const [archive, setArchive] = useState(
    automation?.autoArchiveSession ?? false,
  );
  const [actionType, setActionType] = useState<"runAgent" | "runScript">(
    automation?.action.type ?? "runAgent",
  );
  const [action, setAction] = useState(
    automation?.action.type === "runAgent"
      ? automation.action.prompt
      : (automation?.action.command ?? ""),
  );
  const [cwd, setCwd] = useState(
    automation?.action.type === "runScript"
      ? (automation.action.cwd ?? "")
      : "",
  );
  const connections = useQuery({
    queryKey: ["automationGmailConnections"],
    queryFn: async () => await api.automations.gmailConnections(),
    enabled: type === "trigger" && kind === "gmail",
  });
  const valid = Boolean(
    name.trim() &&
    action.trim() &&
    (type === "routine"
      ? cron.trim() && timezone.trim()
      : kind === "webhook" || connectionAddress),
  );
  const save = useMutation({
    mutationFn: async () => {
      const activation: AutomationActivation =
        type === "routine"
          ? { type, schedule: { cron: cron.trim(), timezone: timezone.trim() } }
          : {
              type,
              trigger:
                kind === "webhook"
                  ? { type: kind }
                  : {
                      type: kind,
                      connectionAddress,
                      event: "messageReceived",
                      from: from.trim() || undefined,
                      subjectContains: subject.trim() || undefined,
                    },
            };
      return await api.automations.save({
        id: automation?.id,
        extensionId: automation?.extensionId,
        name: name.trim(),
        activation,
        enabled,
        autoArchiveSession: archive,
        action:
          actionType === "runAgent"
            ? { type: actionType, prompt: action }
            : {
                type: actionType,
                command: action,
                cwd: cwd.trim() || undefined,
              },
      });
    },
    onSuccess: onSaved,
  });
  const overlay = useStyles(styles.overlay);
  const modal = useStyles(styles.modal);
  const form = useStyles(styles.form);
  const heading = useStyles(styles.modalHeading);
  const label = useStyles(styles.label);
  const editor = useStyles(styles.editor);
  const buttons = useStyles(styles.modalButtons);
  const error = useStyles(styles.error);
  const actionLabel = actionType === "runAgent" ? "Agent prompt" : "Script";
  return (
    <ModalOverlay
      isOpen
      isDismissable={!save.isPending}
      isKeyboardDismissDisabled={save.isPending}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      className={overlay}
    >
      <Modal className={modal}>
        <Dialog
          aria-label={
            automation === undefined
              ? "New automation"
              : `Edit ${automation.name}`
          }
        >
          <form
            className={form}
            onSubmit={(event) => {
              event.preventDefault();
              if (valid && !save.isPending) save.mutate();
            }}
          >
            <h2 className={heading}>
              {automation === undefined ? "New automation" : "Edit automation"}
            </h2>
            <label className={label}>
              Name
              <TextField
                aria-label="Name"
                value={name}
                onChange={setName}
                autoFocus
                maxLength={80}
                isDisabled={save.isPending}
              />
            </label>
            <Select
              label="Activation"
              selectedKey={type}
              onSelectionChange={(key) => {
                if (key === "routine" || key === "trigger") setType(key);
              }}
              isDisabled={save.isPending}
            >
              <SelectItem id="routine">Routine</SelectItem>
              <SelectItem id="trigger">Trigger</SelectItem>
            </Select>
            {type === "routine" ? (
              <>
                <label className={label}>
                  Schedule (cron)
                  <TextField
                    aria-label="Schedule (cron)"
                    value={cron}
                    onChange={setCron}
                    isDisabled={save.isPending}
                  />
                </label>
                <label className={label}>
                  Time zone
                  <TextField
                    aria-label="Time zone"
                    value={timezone}
                    onChange={setTimezone}
                    isDisabled={save.isPending}
                  />
                </label>
              </>
            ) : (
              <>
                <Select
                  label="Trigger kind"
                  selectedKey={kind}
                  onSelectionChange={(key) => {
                    if (key === "webhook" || key === "gmail") setKind(key);
                  }}
                  isDisabled={save.isPending}
                >
                  <SelectItem id="webhook">Webhook</SelectItem>
                  <SelectItem id="gmail">Gmail</SelectItem>
                </Select>
                {kind === "webhook" ? (
                  <p>
                    A private URL starts this automation when a service sends a
                    POST request. Create it to get the URL.
                  </p>
                ) : (
                  <>
                    <Select
                      label="Gmail connection"
                      placeholder="Choose a connected account"
                      selectedKey={connectionAddress || undefined}
                      onSelectionChange={(key) => {
                        if (key !== null) setConnectionAddress(String(key));
                      }}
                      isDisabled={save.isPending}
                    >
                      {(connections.data ?? []).map((connection) => (
                        <SelectItem
                          key={connection.address}
                          id={connection.address}
                        >
                          {connection.accountLabel ?? connection.name}
                        </SelectItem>
                      ))}
                      {connectionAddress &&
                      !connections.data?.some(
                        (connection) =>
                          connection.address === connectionAddress,
                      ) ? (
                        <SelectItem id={connectionAddress}>
                          Saved connection (unavailable)
                        </SelectItem>
                      ) : undefined}
                    </Select>
                    {connections.isPending && (
                      <p>Loading connected accounts…</p>
                    )}
                    {connections.error && (
                      <p role="alert" className={error}>
                        {connections.error.message}
                      </p>
                    )}
                    {connections.data?.length === 0 && (
                      <p>
                        Ask Halo to connect Gmail, then reopen this editor to
                        choose the account.
                      </p>
                    )}
                    <label className={label}>
                      From (optional)
                      <TextField
                        aria-label="From (optional)"
                        placeholder="sender@example.com"
                        value={from}
                        onChange={setFrom}
                        isDisabled={save.isPending}
                      />
                    </label>
                    <label className={label}>
                      Subject contains (optional)
                      <TextField
                        aria-label="Subject contains (optional)"
                        value={subject}
                        onChange={setSubject}
                        isDisabled={save.isPending}
                      />
                    </label>
                    <p>
                      Runs for new incoming inbox messages. Existing mail is not
                      imported.
                    </p>
                  </>
                )}
              </>
            )}
            <Select
              label="Action"
              selectedKey={actionType}
              onSelectionChange={(key) => {
                if (key === "runAgent" || key === "runScript")
                  setActionType(key);
              }}
              isDisabled={save.isPending}
            >
              <SelectItem id="runAgent">Agent call</SelectItem>
              <SelectItem id="runScript">Script</SelectItem>
            </Select>
            <label className={label}>
              {actionLabel}
              <textarea
                className={editor}
                aria-label={actionLabel}
                value={action}
                onChange={(event) => setAction(event.target.value)}
                rows={4}
                spellCheck={actionType === "runAgent"}
                disabled={save.isPending}
              />
            </label>
            {actionType === "runScript" && (
              <label className={label}>
                Working directory (optional)
                <TextField
                  aria-label="Working directory (optional)"
                  value={cwd}
                  onChange={setCwd}
                  placeholder="Workspace relative path"
                  isDisabled={save.isPending}
                />
              </label>
            )}
            <Select
              label="Automation status"
              selectedKey={enabled ? "active" : "paused"}
              onSelectionChange={(key) => setEnabled(key === "active")}
              isDisabled={save.isPending}
            >
              <SelectItem id="active">Active</SelectItem>
              <SelectItem id="paused">Paused</SelectItem>
            </Select>
            <Select
              label="After run"
              selectedKey={archive ? "archive" : "show"}
              onSelectionChange={(key) => setArchive(key === "archive")}
              isDisabled={save.isPending}
            >
              <SelectItem id="show">Show session</SelectItem>
              <SelectItem id="archive">Auto archive session</SelectItem>
            </Select>
            {save.error && (
              <div className={error} role="alert">
                {save.error.message}
              </div>
            )}
            <div className={buttons}>
              <Button
                variant="quiet"
                onClick={onClose}
                isDisabled={save.isPending}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                variant="primary"
                isDisabled={!valid || save.isPending}
              >
                {save.isPending
                  ? "Saving…"
                  : automation === undefined
                    ? "Create"
                    : "Save"}
              </Button>
            </div>
          </form>
        </Dialog>
      </Modal>
    </ModalOverlay>
  );
}
