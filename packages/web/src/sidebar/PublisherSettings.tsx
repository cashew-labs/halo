import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Flex, Text, TextField, colors, flex, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useAuthenticatedUserId } from "../Authentication.js";
import { useApi } from "../api/ApiProvider.js";

/** Mounted only inside the signed-in workspace account dialog. */
export function PublisherSettings({
  onSaving,
}: {
  onSaving(saving: boolean): void;
}) {
  const api = useApi();
  const userId = useAuthenticatedUserId();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<string>();
  const hint = useStyles(hintStyle);
  const row = useStyles(rowStyle);
  const problemHint = useStyles(hintStyle, problemStyle);
  // The full-width input would otherwise shrink Save below its label.
  const saveButton = useStyles(saveStyle);
  const saving = useRef(false);
  const publisher = useQuery({
    queryKey: ["publisher", userId],
    queryFn: async () => await api.apps.publisher(),
    retry: false,
    staleTime: 0,
  });
  const handle = draft ?? publisher.data?.handle ?? "";
  const changed =
    publisher.data !== undefined && handle !== publisher.data.handle;
  const availability = useQuery({
    queryKey: ["publisher-handle", userId, handle],
    queryFn: async () => await api.apps.checkPublisherHandle({ handle }),
    enabled: changed,
    retry: false,
    staleTime: 0,
  });
  const save = useMutation({
    mutationFn: async () => await api.apps.renamePublisher({ handle }),
    onSuccess: (saved) => {
      queryClient.setQueryData(["publisher", userId], saved);
      setDraft(undefined);
      void queryClient
        .invalidateQueries({ queryKey: ["apps"] })
        .catch(console.error);
    },
    onSettled: () => {
      saving.current = false;
      onSaving(false);
    },
  });
  const canSave =
    changed &&
    availability.data?.available === true &&
    !availability.isFetching &&
    !availability.isError &&
    !save.isPending;
  // One line reports the handle's state; problems replace the hint, never stack.
  const [status, problem] = save.isPending
    ? ["Saving…", false]
    : save.error != undefined
      ? [save.error.message, true]
      : !changed
        ? [
            save.isSuccess
              ? `Saved. ${publisher.data?.origin}`
              : publisher.data?.origin,
            false,
          ]
        : availability.isFetching
          ? ["Checking availability…", false]
          : availability.error != undefined
            ? [
                `Could not check availability: ${availability.error.message}`,
                true,
              ]
            : availability.data?.available
              ? ["Available. Existing app links will stop working.", false]
              : [availability.data?.reason, true];
  const statusClass = useStyles(hintStyle, problem && problemStyle);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!canSave || saving.current) return;
        saving.current = true;
        onSaving(true);
        save.mutate();
      }}
    >
      <Flex column gap={2}>
        <Text id="publisher-label" size="xs" fontWeight={600}>
          Publishing URL
        </Text>
        {publisher.isPending && (
          <p role="status" className={hint}>
            Loading…
          </p>
        )}
        {publisher.error != undefined && (
          <div role="alert" className={row}>
            <p className={problemHint}>{publisher.error.message}</p>
            <Button variant="quiet" onPress={() => void publisher.refetch()}>
              Retry
            </Button>
          </div>
        )}
        {publisher.data !== undefined && (
          <>
            <div className={row}>
              <TextField
                aria-labelledby="publisher-label"
                aria-describedby="publisher-status"
                value={handle}
                onChange={(value) => {
                  setDraft(value);
                  save.reset();
                }}
                isDisabled={save.isPending}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck="false"
              />
              {changed && (
                <Button
                  type="submit"
                  className={saveButton}
                  isDisabled={!canSave}
                >
                  Save
                </Button>
              )}
            </div>
            <p
              id="publisher-status"
              role="status"
              aria-live="polite"
              className={statusClass}
            >
              {status}
            </p>
          </>
        )}
      </Flex>
    </form>
  );
}

const hintStyle = style(text({ size: "xs", color: "lowContrast" }), {
  margin: 0,
});
export const problemStyle = style({ color: colors.amber[11] });
const saveStyle = style({ flexShrink: 0 });
const rowStyle = style(flex({ alignItems: "center", gap: 3 }));
