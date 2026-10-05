import { useState } from "react";
import { Button, Dialog, Flex, H3, P, colors, text } from "maui";
import { style, useStyles } from "purse-styles";
import { useConnection } from "./api/ConnectionContext.js";
import {
  useFileSaveErrors,
  type FileSaveError,
} from "./main/FileSaveErrors.js";

export function FileSaveErrorIndicator() {
  const { state } = useConnection();
  const { errors } = useFileSaveErrors();
  if (state.status !== "connected" || errors.length === 0) return;
  return <SaveErrors errors={errors} />;
}

function SaveErrors({ errors }: { errors: FileSaveError[] }) {
  const [open, setOpen] = useState(false);
  const className = useStyles(indicatorStyle);
  const label =
    errors.length === 1 ? "Save error" : `${errors.length} save errors`;
  return (
    <>
      <Button
        variant="quiet"
        aria-label={label}
        className={className}
        onClick={() => setOpen(true)}
      >
        <span aria-hidden="true" style={{ color: colors.red[9] }}>
          ●
        </span>
        <span role="status" aria-live="polite">
          {label}
        </span>
      </Button>
      {open && (
        <Dialog onClickOutside={() => setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="File save errors">
            <Flex column gap={4}>
              <H3>File save errors</H3>
              {errors.map((error) => (
                <SaveError key={error.id} error={error} />
              ))}
              <Button variant="quiet" onClick={() => setOpen(false)}>
                Close
              </Button>
            </Flex>
          </div>
        </Dialog>
      )}
    </>
  );
}

function SaveError({ error }: { error: FileSaveError }) {
  const [retrying, setRetrying] = useState(false);
  return (
    <section aria-label={error.path}>
      <Flex column gap={2}>
        <P>
          <strong>{error.path}</strong>
        </P>
        <P>{error.message}</P>
        <Button
          isDisabled={retrying}
          onClick={async () => {
            setRetrying(true);
            await error.retry();
            setRetrying(false);
          }}
        >
          {retrying ? "Retrying…" : "Retry save"}
        </Button>
      </Flex>
    </section>
  );
}

const indicatorStyle = style(
  text({ size: "xs", fontWeight: 400, color: "lowContrast" }),
  { justifyContent: "flex-start", gap: 6, padding: 0, minHeight: 24 },
);
