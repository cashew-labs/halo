import * as errore from "errore";
import { IncompatibleServerError } from "./protocol.js";

export class AuthenticationRequiredError extends errore.createTaggedError({
  name: "AuthenticationRequiredError",
  message: "Sign in to reconnect to Halo.",
}) {}

export class ConnectionUnavailableError extends errore.createTaggedError({
  name: "ConnectionUnavailableError",
  message:
    "Halo is reconnecting. This action was not sent; try again when connected.",
}) {}

export class ConnectionHttpError extends errore.createTaggedError({
  name: "ConnectionHttpError",
  message: "The $service connection failed during $stage (HTTP $status).",
}) {}

// IPC serializes error objects without their custom properties. Carry expected
// connection failures as data and reconstruct them in the renderer instead.
export type ConnectionFailureData =
  | {
      connectionFailure: "incompatible";
      service: "workspace" | "control-plane";
      clientProtocolVersion: number;
      supportedProtocols: number[];
    }
  | { connectionFailure: "authentication" }
  | { connectionFailure: "transport"; message: string };

export function serializeConnectionFailure(
  error: Error,
): ConnectionFailureData {
  const mismatch = errore.findCause(error, IncompatibleServerError);
  if (mismatch !== undefined)
    return {
      connectionFailure: "incompatible",
      service: mismatch.service === "workspace" ? "workspace" : "control-plane",
      clientProtocolVersion: Number(mismatch.clientProtocolVersion),
      supportedProtocols: mismatch.supportedProtocols,
    };
  if (errore.findCause(error, AuthenticationRequiredError) !== undefined)
    return { connectionFailure: "authentication" };
  console.warn("Desktop connection failed:", error);
  return { connectionFailure: "transport", message: error.message };
}

class DesktopConnectionError extends errore.createTaggedError({
  name: "DesktopConnectionError",
  message: "$detail",
}) {}

export function restoreConnectionFailure<T extends object>(
  value: T | ConnectionFailureData | undefined,
) {
  if (value === undefined || !("connectionFailure" in value)) return value;
  if (value.connectionFailure === "incompatible")
    return new IncompatibleServerError(value);
  if (value.connectionFailure === "authentication")
    return new AuthenticationRequiredError();
  return new DesktopConnectionError({ detail: value.message });
}
