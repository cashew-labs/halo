import { oc, type, type RouterContractClient } from "@orpc/contract";
import {
  RequestRejectedError,
  type BrowserExecution,
  type BrowserSnapshot,
} from "@get-halo/client";

export const appControlContract = oc
  .errors({ [RequestRejectedError.code]: RequestRejectedError })
  .router({
    exec: oc.input(type<{ source: string }>()).output(type<BrowserExecution>()),
    snapshot: oc.output(type<BrowserSnapshot>()),
    screenshot: oc.output(type<{ path: string }>()),
  });

export type AppControlClient = RouterContractClient<typeof appControlContract>;
