import { useState } from "react";
import { Button, Flex, MauiProvider, Text } from "maui";
import type { ExtensionViewProps } from "@get-halo/extension-sdk/view";
import * as errore from "errore";
import type extension from "./extension.js";
import type { relations, schema } from "./schema.js";

class NotesError extends errore.createTaggedError({
  name: "NotesError",
  message: "Could not read workspace notes",
}) {}

// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this entry from the scaffolded test package.
export default function WorkspaceNotes({
  api,
}: ExtensionViewProps<typeof extension, typeof schema, typeof relations>) {
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string>();

  return (
    <MauiProvider>
      <Flex column gap={4} p={8}>
        <Button
          onClick={async () => {
            const response = await api.notes
              .$get()
              .catch((cause) => new NotesError({ cause }));
            if (response instanceof Error) {
              setError(response.message);
              return;
            }
            const result = await response
              .json()
              .catch((cause) => new NotesError({ cause }));
            if (result instanceof Error) {
              setError(result.message);
              return;
            }
            if ("error" in result) {
              setError(result.error);
              return;
            }
            setError(undefined);
            setNotes(result.text);
          }}
        >
          Refresh notes
        </Button>
        <Text role="status">{notes}</Text>
        {error === undefined ? undefined : <Text role="alert">{error}</Text>}
      </Flex>
    </MauiProvider>
  );
}
