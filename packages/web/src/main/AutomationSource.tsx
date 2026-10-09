import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import * as errore from "errore";
import type { AutomationSourceState } from "@get-halo/client";
import { Button, TextField } from "maui";
import { useStyles } from "purse-styles";
import { useApi } from "../api/ApiProvider.js";
import { automationStyles as styles } from "./automationStyles.js";

class WebhookCopyError extends errore.createTaggedError({
  name: "WebhookCopyError",
  message: "Could not copy the private webhook URL",
}) {}

export function AutomationSource({ state }: { state: AutomationSourceState }) {
  const api = useApi();
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<"url" | "header" | undefined>();
  const access = useMutation({
    mutationFn: async (rotate: boolean) =>
      await api.automations.webhookAccess({
        automationId: state.automationId,
        rotate,
      }),
    onSuccess: () => {
      setCopied(undefined);
      setRotating(false);
    },
  });
  const copy = useMutation({
    mutationFn: async (kind: "url" | "header") => {
      if (access.data === undefined) return;
      const result = await navigator.clipboard
        .writeText(
          kind === "url"
            ? access.data.url
            : `Authorization: Bearer ${access.data.token}`,
        )
        .catch((cause) => new WebhookCopyError({ cause }));
      if (result instanceof Error) throw result;
      setCopied(kind);
    },
  });
  const section = useStyles(styles.section);
  const title = useStyles(styles.sectionTitle);
  const actions = useStyles(styles.actions);
  const error = useStyles(styles.error);
  const label = useStyles(styles.label);
  return (
    <section className={section} aria-label="Trigger source">
      <h3 className={title}>{state.kind === "gmail" ? "Gmail" : "Webhook"}</h3>
      <p role="status">
        {
          {
            pending: "Connecting…",
            active: "Active",
            paused: "Paused",
            needsAttention: "Needs attention",
          }[state.status]
        }
        {state.emailAddress === undefined ? "" : ` · ${state.emailAddress}`}
      </p>
      {state.detail && <p>{state.detail}</p>}
      {state.kind === "webhook" && (
        <>
          <p>
            Send a POST request with a JSON object. Anyone with the private URL
            can start this automation.
          </p>
          {access.data === undefined ? (
            <Button
              onClick={() => access.mutate(false)}
              isDisabled={access.isPending}
            >
              Reveal private URL
            </Button>
          ) : (
            <>
              <label className={label}>
                Private URL
                <TextField
                  aria-label="Private URL"
                  value={access.data.url}
                  isReadOnly
                />
              </label>
              <div className={actions}>
                <Button onClick={() => copy.mutate("url")}>
                  {copied === "url" ? "Copied" : "Copy URL"}
                </Button>
                <Button
                  variant="quiet"
                  onClick={() => {
                    access.reset();
                    setCopied(undefined);
                  }}
                >
                  Hide URL
                </Button>
                <Button variant="quiet" onClick={() => copy.mutate("header")}>
                  {copied === "header"
                    ? "Header copied"
                    : "Copy authorization header"}
                </Button>
                <Button variant="quiet" onClick={() => setRotating(true)}>
                  Rotate token
                </Button>
              </div>
              {rotating && (
                <div role="group" aria-label="Rotate webhook token">
                  <p>
                    Rotation immediately disables the old URL. Update services
                    that use it.
                  </p>
                  <div className={actions}>
                    <Button
                      onClick={() => access.mutate(true)}
                      isDisabled={access.isPending}
                    >
                      Rotate now
                    </Button>
                    <Button variant="quiet" onClick={() => setRotating(false)}>
                      Cancel rotation
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
          {(access.error ?? copy.error) && (
            <p className={error} role="alert">
              {(access.error ?? copy.error)?.message}
            </p>
          )}
        </>
      )}
    </section>
  );
}
