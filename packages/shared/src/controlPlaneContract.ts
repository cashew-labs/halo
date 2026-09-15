import { error, oc, type, type RouterContractClient } from "@orpc/contract";

export const controlPlaneProtocolVersion = 3 as const;

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
    info: oc.output(
      type<{ protocolVersion: typeof controlPlaneProtocolVersion }>(),
    ),
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
    ensure: authenticatedProcedure.output(type<ControlPlaneWorkspace>()),
  },
});

export type ControlPlaneClient = RouterContractClient<
  typeof controlPlaneContract
>;
