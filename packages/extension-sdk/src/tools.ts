import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import * as errore from "errore";

export type ExtensionToolResult<Data = unknown> =
  | {
      ok: true;
      data: Data;
      http?: { status: number; headers: Record<string, string> };
    }
  | {
      ok: false;
      error: {
        code: string;
        message: string;
        status?: number;
        details?: unknown;
        retryable?: boolean;
      };
    };

type ExtensionToolValue =
  | string
  | number
  | boolean
  | null
  | ExtensionToolInput
  | ExtensionToolValue[];
type ExtensionToolInput = { [key: string]: ExtensionToolValue };

export type ExtensionTools = {
  readonly [segment: string]: ExtensionTools;
} & (<Data = unknown>(
  input: ExtensionToolInput,
) => Promise<ExtensionToolResult<Data>>);

class ExtensionToolConnectionError extends errore.createTaggedError({
  name: "ExtensionToolConnectionError",
  message: "Could not call Halo tool '$path'",
}) {}

export function createExtensionTools() {
  const origin = process.env.HALO_EXTENSION_TOOLS_ORIGIN;
  const token = process.env.HALO_EXTENSION_TOOLS_TOKEN;
  if (origin === undefined || token === undefined) {
    return createORPCClient<ExtensionTools>({
      call: async () => ({
        ok: false,
        error: {
          code: "halo_not_connected",
          message: "Start this extension through Halo to use workspace tools.",
        },
      }),
    });
  }
  const client = createORPCClient<{
    invoke(
      input: { path: string; input: unknown },
      options?: { signal?: AbortSignal },
    ): Promise<ExtensionToolResult>;
  }>(
    new RPCLink({
      origin,
      url: "/extension-tools",
      headers: { authorization: `Bearer ${token}` },
    }),
  );
  return createORPCClient<ExtensionTools>({
    async call(segments, input, options) {
      const path = segments.join(".");
      const result = await client
        .invoke({ path, input }, options)
        .catch((cause) => new ExtensionToolConnectionError({ path, cause }));
      if (result instanceof Error) {
        console.warn(result);
        return {
          ok: false,
          error: { code: "tool_invocation_failed", message: result.message },
        };
      }
      return result;
    },
  });
}
