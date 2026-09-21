import * as errore from "errore";

export const protocolHeader = "x-halo-protocol-version";
export type ProtocolService = "workspace" | "control-plane";
export type ServerInfo = {
  protocolVersion: number;
  supportedProtocols?: number[];
};

export class IncompatibleServerError extends errore.createTaggedError({
  name: "IncompatibleServerError",
  message:
    "$service API does not support app protocol $clientProtocolVersion; supported protocols: $protocols.",
}) {
  readonly supportedProtocols: number[];
  constructor(ctx: {
    service: ProtocolService;
    clientProtocolVersion: number;
    supportedProtocols: number[];
  }) {
    super({
      service: ctx.service,
      clientProtocolVersion: ctx.clientProtocolVersion,
      protocols: ctx.supportedProtocols.join(", "),
    });
    this.supportedProtocols = ctx.supportedProtocols;
  }
}

export class InvalidServerInfoError extends errore.createTaggedError({
  name: "InvalidServerInfoError",
  message: "The $service API returned invalid protocol information.",
}) {}

export function checkServerCompatibility(ctx: {
  info: unknown;
  service: ProtocolService;
  clientProtocolVersion: number;
}) {
  const { info, service, clientProtocolVersion } = ctx;
  if (typeof info !== "object" || info === null || !("protocolVersion" in info))
    return new InvalidServerInfoError({ service });
  if (!isProtocol(info.protocolVersion))
    return new InvalidServerInfoError({ service });
  const supported =
    "supportedProtocols" in info
      ? info.supportedProtocols
      : [info.protocolVersion];
  if (
    !Array.isArray(supported) ||
    supported.length === 0 ||
    !supported.every(isProtocol)
  )
    return new InvalidServerInfoError({ service });
  if (!supported.includes(clientProtocolVersion))
    return new IncompatibleServerError({
      service,
      clientProtocolVersion,
      supportedProtocols: supported as number[],
    });
}

export function acceptsProtocol(ctx: {
  selected: string | undefined;
  supported: readonly number[];
  legacy: number;
}) {
  if (ctx.selected === undefined) return ctx.supported.includes(ctx.legacy);
  return (
    /^\d+$/.test(ctx.selected) && ctx.supported.includes(Number(ctx.selected))
  );
}

function isProtocol(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
