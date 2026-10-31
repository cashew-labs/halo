import { useState } from "react";
import type { AgentRecord } from "@get-halo/client";
import { Button, Tooltip } from "maui";
import { Settings } from "maui/icons";
import { AgentDialog } from "./AgentDialog.js";

export function AgentSettingsButton({ agent }: { agent: AgentRecord }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Tooltip content="Agent settings" placement="bottom">
        <Button
          variant="quiet"
          aria-label="Agent settings"
          onPress={() => setOpen(true)}
        >
          <Settings size="sm" />
        </Button>
      </Tooltip>
      <AgentDialog agent={agent} isOpen={open} onOpenChange={setOpen} />
    </>
  );
}
