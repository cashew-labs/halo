import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import * as errore from "errore";

export const protocolHeader = "x-halo-protocol-version";
export type ProtocolService = "workspace" | "control-plane";
export type ServerInfo = {
  protocolVersion: number;
  supportedProtocols?: number[];
  build?: { version: string; revision: string };
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

const protocolSchema = Type.Integer({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const serverInfoSchema = Type.Object({
  protocolVersion: protocolSchema,
  supportedProtocols: Type.Optional(
    Type.Array(protocolSchema, { minItems: 1 }),
  ),
});

export function checkServerCompatibility(ctx: {
  info: unknown;
  service: ProtocolService;
  clientProtocolVersion: number;
}) {
  const { info, service, clientProtocolVersion } = ctx;
  if (!Value.Check(serverInfoSchema, info))
    return new InvalidServerInfoError({ service });
  const supported = info.supportedProtocols ?? [info.protocolVersion];
  if (!supported.includes(clientProtocolVersion))
    return new IncompatibleServerError({
      service,
      clientProtocolVersion,
      supportedProtocols: supported,
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
