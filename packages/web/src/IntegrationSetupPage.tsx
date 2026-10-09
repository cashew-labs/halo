import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Button,
  Flex,
  H2,
  P,
  RadioOption,
  RadioOptionGroup,
  Text,
  TextField,
  proseContainerStyle,
} from "maui";
import { style, useStyles } from "purse-styles";
import type { IntegrationSetup } from "@get-halo/shared/controlPlaneContract";
import type { HostApi } from "./HostApi.js";

const page = style(proseContainerStyle, {
  width: "100%",
  maxWidth: "480px",
  marginInline: "auto",
  padding: "64px 24px",
  boxSizing: "border-box",
});

type SetupApi = NonNullable<HostApi["integrationSetup"]>;

export function IntegrationSetupPage({
  setupId,
  api,
}: {
  setupId: string;
  api: SetupApi;
}) {
  const className = useStyles(page);
  const queryClient = useQueryClient();
  const queryKey = ["integration-setup", setupId];
  const setup = useQuery({
    queryKey,
    queryFn: async () => {
      const result = await api.read(setupId);
      if (result instanceof Error) throw result;
      return result;
    },
    refetchInterval: (query) =>
      query.state.data?.status === "authorizing" ||
      query.state.data?.status === "confirming" ||
      query.state.data?.status === "awaiting_credentials"
        ? 1500
        : false,
  });
  const cancel = useMutation({
    mutationFn: async () => {
      const result = await api.cancel(setupId);
      if (result instanceof Error) throw result;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const data = setup.data;
  return (
    <main className={className}>
      <Flex column gap={8}>
        <Text size="sm" color="lowContrast">
          Halo connections
        </Text>
        <H2>
          {data === undefined
            ? "Connect an account"
            : data.status === "ready"
              ? `${data.name} connected`
              : `Connect ${data.name}`}
        </H2>
        {setup.isPending && <P>Loading connection details…</P>}
        {setup.isError && (
          <>
            <div role="alert">
              <P>
                This connection setup is unavailable. Make sure you are signed
                in to the Halo account that requested it.
              </P>
            </div>
            <Button
              onClick={async () => {
                await setup.refetch();
              }}
            >
              Try again
            </Button>
          </>
        )}
        {data !== undefined && (
          <>
            <Text size="sm" color="lowContrast">
              Connection: {data.connectionName}
            </Text>
            {data.account !== undefined && data.status !== "ready" && (
              <P>
                Halo asked to connect <strong>{data.account}</strong>. Choose
                that account on the provider’s sign-in screen, or choose another
                account.
              </P>
            )}
            {data.status === "awaiting_credentials" && (
              <SetupForm
                key={setupId}
                setup={data}
                api={api}
                onSaved={async () => {
                  await queryClient.invalidateQueries({ queryKey });
                }}
              />
            )}
            {data.status === "authorizing" && (
              <div role="status">
                <P>
                  Waiting for authorization. Complete sign-in with the provider,
                  or cancel and start again from Halo.
                </P>
              </div>
            )}
            {data.status === "ready" && (
              <>
                <div role="status">
                  <P>
                    Your connection is ready. You can close this tab and return
                    to Halo.
                  </P>
                </div>
                {data.connection?.accountLabel && (
                  <Text>{data.connection.accountLabel}</Text>
                )}
              </>
            )}
            {data.status === "confirming" && (
              <div role="status">
                <P>
                  Connection saved; confirming status… You do not need to
                  connect again. This page will update automatically.
                </P>
              </div>
            )}
            {data.status === "cancelled" && (
              <div role="status">
                <P>
                  Connection cancelled. No new connection was created. You can
                  start again from Halo.
                </P>
              </div>
            )}
            {data.status === "expired" && (
              <div role="status">
                <P>
                  This setup has expired. Return to Halo and click Connect to
                  start again.
                </P>
              </div>
            )}
            {data.status === "failed" && (
              <div role="alert">
                <P>
                  {data.message ??
                    "Connection setup failed. Return to Halo to try again."}
                </P>
              </div>
            )}
            {(data.status === "awaiting_credentials" ||
              data.status === "authorizing") && (
              <Button
                variant="quiet"
                isDisabled={cancel.isPending}
                onClick={() => cancel.mutate()}
              >
                Cancel connection
              </Button>
            )}
            {cancel.isError && (
              <div role="alert">
                <P>
                  Could not cancel. Connection setup may already be completing.
                  Refresh its status before trying again.
                </P>
              </div>
            )}
          </>
        )}
      </Flex>
    </main>
  );
}

function SetupForm({
  setup,
  api,
  onSaved,
}: {
  setup: IntegrationSetup;
  api: SetupApi;
  onSaved(): Promise<void>;
}) {
  const [template, setTemplate] = useState(setup.methods[0]?.template ?? "");
  const [values, setValues] = useState<Record<string, string>>({});
  const method = setup.methods.find((entry) => entry.template === template);
  const submit = useMutation({
    mutationFn: async () => {
      const result = await api.submit({
        setupId: setup.setupId,
        template,
        values,
      });
      setValues({});
      if (result instanceof Error) throw result;
      if (result.authorizationUrl !== undefined)
        window.location.assign(result.authorizationUrl);
    },
    onSettled: onSaved,
  });
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit.mutate();
      }}
    >
      <Flex column gap={8}>
        <P>
          Connecting lets your agents and background extensions use this
          account’s tools, including actions that change data, within the access
          you grant. There are no additional per-action approval prompts.
        </P>
        {setup.methods.length > 1 && (
          <RadioOptionGroup
            label="Authentication method"
            value={template}
            onChange={(value) => {
              setTemplate(value);
              setValues({});
            }}
            isDisabled={submit.isPending}
          >
            {setup.methods.map((entry) => (
              <RadioOption key={entry.template} value={entry.template}>
                {entry.label}
              </RadioOption>
            ))}
          </RadioOptionGroup>
        )}
        {method?.fields.map((field) => (
          <Flex column gap={3} key={field}>
            <label htmlFor={`credential-${field}`}>{field}</label>
            <TextField
              id={`credential-${field}`}
              aria-label={field}
              type="password"
              autoComplete="off"
              isRequired
              isDisabled={submit.isPending}
              value={values[field] ?? ""}
              onChange={(value) =>
                setValues((current) => ({ ...current, [field]: value }))
              }
            />
          </Flex>
        ))}
        {method !== undefined && method.fields.length > 0 && (
          <Text size="sm" color="lowContrast">
            Credentials are encrypted on Halo’s control plane. They are not sent
            to the agent or workspace.
          </Text>
        )}
        {submit.isError && (
          <div role="alert">
            <P>
              Could not complete setup. Check the connection status or start
              again from Halo.
            </P>
          </div>
        )}
        <Button
          type="submit"
          variant="primary"
          isDisabled={method === undefined || submit.isPending}
        >
          {submit.isPending
            ? "Connecting…"
            : method?.kind === "oauth"
              ? `Continue to ${setup.name}`
              : "Connect"}
        </Button>
      </Flex>
    </form>
  );
}
