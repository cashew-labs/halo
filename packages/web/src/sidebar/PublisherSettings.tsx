import { useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Flex, P, TextField } from "maui";
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
      <Flex column gap={4}>
        <P>Extension publishing URL</P>
        {publisher.isPending && <p role="status">Loading publishing URL…</p>}
        {publisher.error != undefined && (
          <div role="alert">
            <P>Publishing settings unavailable: {publisher.error.message}</P>
            <Button onPress={() => void publisher.refetch()}>Retry</Button>
          </div>
        )}
        {publisher.data !== undefined && (
          <>
            <P>{publisher.data.origin}</P>
            <TextField
              aria-label="Creator handle"
              aria-describedby="publisher-help publisher-status"
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
            <p id="publisher-help">
              Use lowercase letters, numbers or hyphens. Changing your handle
              changes every published app link. Old links will stop working and
              visitors will need to sign in again.
            </p>
            <div id="publisher-status" role="status" aria-live="polite">
              {save.isPending
                ? "Saving…"
                : save.isSuccess
                  ? "Publishing URL saved."
                  : !changed
                    ? "This is your current handle."
                    : availability.isFetching
                      ? "Checking availability…"
                      : availability.error != undefined
                        ? `Could not check availability: ${availability.error.message}`
                        : availability.data?.available
                          ? "Handle available."
                          : availability.data?.reason}
            </div>
            {save.error != undefined && (
              <p role="alert">{save.error.message}</p>
            )}
            <Button type="submit" isDisabled={!canSave}>
              Save handle
            </Button>
          </>
        )}
      </Flex>
    </form>
  );
}
