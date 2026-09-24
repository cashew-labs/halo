import type { SessionRepo as PiSessionRepo } from "@earendil-works/pi-agent-core";
import type { DatabaseError } from "./DatabaseError.js";

export type SessionProductFields = {
  markedDone: boolean;
  readReceiptCursorId?: string;
};

export interface SessionRepoApi extends PiSessionRepo {
  listProductFields(): Promise<
    ReadonlyMap<string, SessionProductFields> | DatabaseError
  >;
  getProductFields(
    sessionId: string,
  ): Promise<SessionProductFields | undefined | DatabaseError>;
  setMarkedDone(input: {
    sessionId: string;
    markedDone: boolean;
  }): Promise<void | DatabaseError>;
  setReadReceipt(input: {
    sessionId: string;
    readReceiptCursorId?: string;
  }): Promise<void | DatabaseError>;
}
