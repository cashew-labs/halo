import { Button, Flex, P } from "maui";
import type { useAutosaveFile } from "./useAutosaveFile.js";

export function FileSaveStatus({
  save,
}: {
  save: ReturnType<typeof useAutosaveFile>;
}) {
  if (save.message === undefined) return;
  return (
    <Flex row gap={3}>
      <div role="status">
        <P>{save.message}</P>
      </div>
      <Button variant="quiet" isDisabled={!save.connected} onClick={save.retry}>
        Retry save
      </Button>
    </Flex>
  );
}
