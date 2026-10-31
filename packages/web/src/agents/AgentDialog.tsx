import { useRef, useState } from "react";
import type { AgentRecord, NewAgentInput } from "@get-halo/client";
import * as errore from "errore";
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogTitle,
  Flex,
  Text,
  TextField,
  colors,
  spacing,
  textFieldStyles,
} from "maui";
import { style, useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";

class SaveAgentError extends errore.createTaggedError({
  name: "SaveAgentError",
  message: "Couldn't $action. Try again.",
}) {}

export function AgentDialog({
  agent,
  isOpen,
  onOpenChange,
  onCreated,
}: {
  agent?: AgentRecord;
  isOpen: boolean;
  onOpenChange(open: boolean): void;
  onCreated?(agent: AgentRecord): void;
}) {
  const api = useApi();
  const [name, setName] = useState(agent?.name ?? "");
  const [instructions, setInstructions] = useState(agent?.instructions ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SaveAgentError>();
  const [request, setRequest] = useState<NewAgentInput>();
  const [wasOpen, setWasOpen] = useState(isOpen);
  const pending = useRef(false);
  const label = useStyles(styles.label);
  const editor = useStyles(textFieldStyles.input(), styles.editor);
  const problem = useStyles(styles.problem);

  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setName(agent?.name ?? "");
      setInstructions(agent?.instructions ?? "");
      setError(undefined);
      setRequest(undefined);
    }
  }

  async function save() {
    if (pending.current || name.trim() === "") return;
    pending.current = true;
    setSaving(true);
    setError(undefined);
    // Creation can commit before its response is lost. Retry the same identity and input.
    const input = request ?? {
      requestId: crypto.randomUUID(),
      name: name.trim(),
      instructions: "",
    };
    setRequest(input);
    const saved = await (
      agent === undefined
        ? api.agents.new(input)
        : api.agents.update({
            agentId: agent.id,
            name: name.trim(),
            instructions,
          })
    ).catch(
      (cause) =>
        new SaveAgentError({
          action:
            agent === undefined ? "create this agent" : "save these settings",
          cause,
        }),
    );
    pending.current = false;
    setSaving(false);
    if (saved instanceof Error) {
      console.warn("Agent save failed:", saved);
      setError(saved);
      return;
    }
    onOpenChange(false);
    if (agent === undefined) onCreated?.(saved);
  }

  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      isDismissable={!saving}
      isKeyboardDismissDisabled={saving}
      aria-label={agent === undefined ? "New agent" : "Agent settings"}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          await save();
        }}
      >
        <DialogTitle>
          {agent === undefined ? "New agent" : "Agent settings"}
        </DialogTitle>
        <DialogBody>
          <Flex column gap={6}>
            <label className={label}>
              <Text size="sm">Name</Text>
              <TextField
                aria-label="Name"
                value={name}
                onChange={setName}
                autoFocus
                isDisabled={saving}
                isReadOnly={agent === undefined && request !== undefined}
              />
            </label>
            {agent !== undefined && (
              <label className={label}>
                <Text size="sm">Instructions</Text>
                <textarea
                  className={editor}
                  aria-label="Instructions"
                  value={instructions}
                  onChange={(event) =>
                    setInstructions(event.currentTarget.value)
                  }
                  disabled={saving}
                  rows={7}
                />
              </label>
            )}
            {error !== undefined && (
              <Text role="alert" size="sm" className={problem}>
                {error.message}
              </Text>
            )}
          </Flex>
        </DialogBody>
        <DialogActions>
          <Button onPress={() => onOpenChange(false)} isDisabled={saving}>
            Cancel
          </Button>
          <Button
            type="submit"
            variant="primary"
            isDisabled={saving || name.trim() === ""}
          >
            {saving
              ? agent === undefined
                ? "Creating…"
                : "Saving…"
              : error !== undefined
                ? "Retry"
                : agent === undefined
                  ? "Create"
                  : "Save"}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

const styles = {
  label: style({
    display: "flex",
    flexDirection: "column",
    gap: spacing.value(2),
  }),
  editor: style({ height: "auto", minHeight: "140px", resize: "vertical" }),
  problem: style({ color: colors.red[11] }),
};
