import * as errore from "errore";

export class ThreadBackendError extends errore.createTaggedError({
  name: "ThreadBackendError",
  message: "Thread storage: $detail",
}) {}

export function decodeThreadJson<T>(payload: string): T {
  // SAFETY: These payloads are written from Pi's typed values by this backend and read under the same schema version.
  return JSON.parse(payload) as T;
}
