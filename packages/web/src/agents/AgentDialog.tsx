import { useRef, useState } from "react";
import type { AgentAvatar, AgentRecord, NewAgentInput } from "@get-halo/client";
import * as errore from "errore";
import { Dialog } from "maui";
import { useApi } from "../api/ApiProvider.js";
import { AgentForm } from "./AgentForm.js";
import { randomAvatar } from "./AvatarPicker.js";

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
  const [avatar, setAvatar] = useState<AgentAvatar>(
    () => agent?.avatar ?? randomAvatar(),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<SaveAgentError>();
  const [request, setRequest] = useState<NewAgentInput>();
  const [wasOpen, setWasOpen] = useState(isOpen);
  const pending = useRef(false);

  if (wasOpen !== isOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setName(agent?.name ?? "");
      setAvatar(agent?.avatar ?? randomAvatar());
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
      avatar,
    };
    setRequest(input);
    const saved = await (
      agent === undefined
        ? api.agents.new(input)
        : api.agents.update({
            agentId: agent.id,
            name: name.trim(),
            avatar,
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
      <AgentForm
        isNew={agent === undefined}
        name={name}
        onNameChange={setName}
        avatar={avatar}
        onAvatarChange={setAvatar}
        saving={saving}
        locked={agent === undefined && request !== undefined}
        error={error?.message}
        onCancel={() => onOpenChange(false)}
        onSubmit={save}
      />
    </Dialog>
  );
}
