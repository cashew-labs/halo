import * as errore from "errore";
import { checkServerCompatibility, type ServerInfo } from "@get-halo/client";
import { error, oc, type, type RouterContractClient } from "@orpc/contract";

export const controlPlaneProtocolVersion = 3 as const;
export const controlPlaneSupportedProtocols = [controlPlaneProtocolVersion];

export type ControlPlaneSession = {
  session: {
    id: string;
    userId: string;
    expiresAt: string;
  };
  user: {
    id: string;
    email: string;
    name: string;
    image?: string;
  };
};

export type DesktopAuthSession = ControlPlaneSession & {
  token: string;
};

export type ControlPlaneAuthentication =
  | { status: "signed-out" }
  | { status: "signed-in"; session: ControlPlaneSession };

/** VM lifecycle only; the app separately tracks its workspace connection. */
export type ControlPlaneWorkspaceStatus = {
  status: "running" | "sleeping" | "asleep" | "waking";
};

export type ControlPlaneWorkspace = {
  id: string;
  createdAt: string;
};

export const ControlPlaneRequestError = error("BAD_REQUEST", {
  message: "The control plane could not complete the request.",
  data: type<{ message: string }>(),
});

const publicProcedure = oc.errors({
  [ControlPlaneRequestError.code]: ControlPlaneRequestError,
});

const authenticatedProcedure = publicProcedure.errors({
  UNAUTHORIZED: {},
});

export const controlPlaneContract = publicProcedure.router({
  server: {
    info: oc.output(type<ServerInfo>()),
  },
  auth: {
    start: publicProcedure
      .input(type<{ callback: string; state: string }>())
      .output(type<{ authorizationUrl: string }>()),
    exchange: publicProcedure
      .input(type<{ code: string }>())
      .output(type<DesktopAuthSession>()),
    session: publicProcedure.output(type<ControlPlaneAuthentication>()),
  },
  workspace: {
    status: authenticatedProcedure.output(type<ControlPlaneWorkspaceStatus>()),
    ensure: authenticatedProcedure.output(type<ControlPlaneWorkspace>()),
    rotateRuntimeToken:
      authenticatedProcedure.output(type<ControlPlaneWorkspace>()),
  },
});

export type ControlPlaneClient = RouterContractClient<
  typeof controlPlaneContract
>;

export async function checkControlPlaneCompatibility(
  client: ControlPlaneClient,
  signal?: AbortSignal,
) {
  const info = await client.server
    .info(undefined, { signal })
    .catch((cause) => new ControlPlaneConnectionError({ cause }));
  if (info instanceof Error) return info;
  return checkServerCompatibility({
    info,
    service: "control-plane",
    clientProtocolVersion: controlPlaneProtocolVersion,
  });
}

class ControlPlaneConnectionError extends errore.createTaggedError({
  name: "ControlPlaneConnectionError",
  message: "Could not check the control-plane API.",
}) {}
