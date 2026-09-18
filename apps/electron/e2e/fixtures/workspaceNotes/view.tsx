import { useState } from "react";
import { Button, Flex, MauiProvider, Padding, Text } from "maui";
import type { ExtensionViewProps } from "@get-halo/extension-sdk/view";
import * as errore from "errore";
import type router from "./api.js";
import type { relations, schema } from "./schema.js";

class NotesError extends errore.createTaggedError({
  name: "NotesError",
  message: "Could not read workspace notes",
}) {}

// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this entry from the scaffolded test package.
export default function WorkspaceNotes({
  api,
}: ExtensionViewProps<typeof router, typeof schema, typeof relations>) {
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string>();

  return (
    <MauiProvider>
      <Padding xy={8}>
        <Flex column gap={4}>
          <Button
            onClick={async () => {
              const result = await api
                .notes()
                .catch((cause) => new NotesError({ cause }));
              if (result instanceof Error) {
                setError(result.message);
                return;
              }
              setError(undefined);
              setNotes(result);
            }}
          >
            Refresh notes
          </Button>
          <Text role="status">{notes}</Text>
          {error === undefined ? undefined : <Text role="alert">{error}</Text>}
        </Flex>
      </Padding>
    </MauiProvider>
  );
}
