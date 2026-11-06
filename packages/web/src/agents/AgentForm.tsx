import { useEffect, useRef, useState } from "react";
import type { AgentAvatar } from "@get-halo/client";
import {
  Button,
  DialogActions,
  DialogBody,
  DialogTitle,
  Flex,
  Text,
  TextField,
  colors,
  dialogStyles,
} from "maui";
import { style, useStyles } from "purse-styles";
import { AvatarPicker } from "./AvatarPicker.js";
import { BotAvatar } from "./BotAvatar.js";

/** The agent form shared by the app dialog and the user-flow previews. */
export function AgentForm({
  isNew,
  name,
  onNameChange,
  avatar,
  onAvatarChange,
  saving,
  locked,
  error,
  onCancel,
  onSubmit,
}: {
  isNew: boolean;
  name: string;
  onNameChange(name: string): void;
  avatar: AgentAvatar;
  onAvatarChange(avatar: AgentAvatar): void;
  saving: boolean;
  // A creation retry must resend the same name and avatar.
  locked: boolean;
  error?: string;
  onCancel(): void;
  onSubmit(): void;
}) {
  const form = useStyles(dialogStyles.dialog);
  const problem = useStyles(styles.problem);
  const [happy, setHappy] = useState(false);
  const calm = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(calm.current), []);
  return (
    <form
      className={form}
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
    >
      <DialogTitle>{isNew ? "New agent" : "Agent settings"}</DialogTitle>
      <DialogBody>
        <Flex column gap={8}>
          <Flex row justifyContent="center">
            <BotAvatar
              avatar={avatar}
              size={96}
              followPointer
              mood={happy ? "happy" : "idle"}
              label=""
            />
          </Flex>
          <TextField
            aria-label="Name"
            placeholder="Name your agent"
            value={name}
            onChange={onNameChange}
            autoFocus
            isDisabled={saving}
            isReadOnly={locked}
          />
          <AvatarPicker
            avatar={avatar}
            onChange={(next) => {
              onAvatarChange(next);
              // Each pick restarts a short happy moment.
              setHappy(true);
              clearTimeout(calm.current);
              calm.current = setTimeout(() => setHappy(false), 1200);
            }}
            isDisabled={saving || locked}
          />
          {error !== undefined && (
            <Text role="alert" size="sm" className={problem}>
              {error}
            </Text>
          )}
        </Flex>
      </DialogBody>
      <DialogActions>
        <Button onPress={onCancel} isDisabled={saving}>
          Cancel
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={saving || name.trim() === ""}
        >
          {saving
            ? isNew
              ? "Creating…"
              : "Saving…"
            : error !== undefined
              ? "Retry"
              : isNew
                ? "Create"
                : "Save"}
        </Button>
      </DialogActions>
    </form>
  );
}

const styles = {
  problem: style({ color: colors.red[11] }),
};
