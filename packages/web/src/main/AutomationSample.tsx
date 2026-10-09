import { automationEventSchema } from "@get-halo/client";
import { Value } from "@sinclair/typebox/value";
import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as errore from "errore";
import { Button } from "maui";
import { useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";
import { automationStyles as styles } from "./automationStyles.js";

class SampleInputError extends errore.createTaggedError({
  name: "SampleInputError",
  message: "$detail",
}) {}

export function AutomationSample({ automationId }: { automationId: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [sample, setSample] = useState("{}");
  const run = useMutation({
    mutationFn: async () => {
      if (new TextEncoder().encode(sample).length > 256 * 1024)
        throw new SampleInputError({
          detail: "Sample input must be at most 256 KiB.",
        });
      const parsed = errore.try({
        // SAFETY: Parsed JSON stays unknown until the payload schema is checked.
        try: () => JSON.parse(sample) as unknown,
        catch: (cause) =>
          new SampleInputError({ detail: "Enter a valid JSON object.", cause }),
      });
      if (parsed instanceof Error) throw parsed;
      if (!Value.Check(automationEventSchema.properties.payload, parsed))
        throw new SampleInputError({
          detail: 'Enter a JSON object, such as {"orderId":"123"}.',
        });
      return await api.automations.runNow({
        automationId,
        samplePayload: parsed,
      });
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["automationRuns", automationId],
      });
    },
  });
  const section = useStyles(styles.section);
  const heading = useStyles(styles.sectionTitle);
  const editor = useStyles(styles.editor);
  const error = useStyles(styles.error);
  return (
    <section className={section} aria-label="Test trigger">
      <h3 className={heading}>Test with sample input</h3>
      <p>
        This runs the saved action with your JSON, including while paused. It
        can make the same changes as a real event.
      </p>
      <textarea
        className={editor}
        aria-label="Sample JSON"
        value={sample}
        onChange={(event) => setSample(event.target.value)}
        rows={4}
        spellCheck={false}
      />
      <Button onClick={() => run.mutate()} isDisabled={run.isPending}>
        Run test
      </Button>
      {run.error && (
        <p className={error} role="alert">
          {run.error.message}
        </p>
      )}
      {run.isSuccess && (
        <p role="status">Test accepted. Follow its result in run history.</p>
      )}
    </section>
  );
}
