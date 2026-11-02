import {
  connectHaloClient,
  createHaloClient,
  IncompatibleServerError,
  protocolHeader,
  type HaloRpcTransport,
} from "@get-halo/client";

export async function connectAutomationWorkspace(transport: HaloRpcTransport) {
  const connected = await connectHaloClient({
    transport,
    signal: AbortSignal.timeout(20_000),
  });
  // Older workspaces retain the automation API on protocol 25 during rollout.
  if (
    connected instanceof IncompatibleServerError &&
    connected.supportedProtocols.includes(25)
  )
    return createHaloClient({
      transport: {
        ...transport,
        headers: { ...transport.headers, [protocolHeader]: "25" },
      },
    });
  if (connected instanceof Error) return connected;
  return connected.client;
}
