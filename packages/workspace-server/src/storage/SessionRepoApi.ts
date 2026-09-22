import type { SessionRepo as PiSessionRepo } from "@earendil-works/pi-agent-core";
import type { DatabaseError } from "./DatabaseError.js";

export type SessionStatus = Readonly<{
  markedDone: boolean;
  readResultId: string | undefined;
}>;

export interface SessionRepoApi extends PiSessionRepo {
  listStatuses(): Promise<ReadonlyMap<string, SessionStatus> | DatabaseError>;
  getStatus(
    sessionId: string,
  ): Promise<SessionStatus | undefined | DatabaseError>;
}
