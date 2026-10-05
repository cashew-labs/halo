import type {
  EntryRecord,
  JsonObject,
  Storage,
  SubmissionRecord,
} from "@earendil-works/pi-durable";
import type { ReadonlyStream } from "@get-halo/shared/Stream";
import type { DatabaseError } from "./DatabaseError.js";

export type ThreadMetadata = { id: string; createdAt: number };
export type ThreadData = {
  readonly seq: number;
  readonly entries: readonly EntryRecord[];
  readonly submissions: readonly SubmissionRecord[];
  readonly documents: Readonly<Record<string, JsonObject>>;
  readonly lastRun?: SubmissionRecord;
};
export type ThreadHandle = {
  metadata: ThreadMetadata;
  storage: Storage;
  fatalCommitErrors: ReadonlyStream<Error>;
  read(): Promise<ThreadData>;
  close(): Promise<void>;
};

export type ThreadProductFields = {
  markedDone: boolean;
  readReceiptCursorId?: string;
};

export interface ThreadRepoApi {
  create(options?: { id?: string }): Promise<ThreadHandle>;
  open(metadata: ThreadMetadata): Promise<ThreadHandle>;
  read(threadId: string): Promise<ThreadData>;
  list(): Promise<readonly ThreadMetadata[]>;
  listPendingThreadIds(): Promise<readonly string[] | DatabaseError>;
  close(): Promise<void | Error>;
  listProductFields(): Promise<
    ReadonlyMap<string, ThreadProductFields> | DatabaseError
  >;
  getProductFields(
    threadId: string,
  ): Promise<ThreadProductFields | undefined | DatabaseError>;
  setMarkedDone(input: {
    threadId: string;
    markedDone: boolean;
  }): Promise<void | DatabaseError>;
  setReadReceipt(input: {
    threadId: string;
    readReceiptCursorId?: string;
  }): Promise<void | DatabaseError>;
}
