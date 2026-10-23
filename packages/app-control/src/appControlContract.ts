import { oc, type, type RouterContractClient } from "@orpc/contract";
import { RequestRejectedError } from "@get-halo/client";

export type BrowserSnapshot = {
  url: string;
  title: string;
  tree: string;
  errors: string[];
};
export type BrowserExecution = {
  result: unknown;
  stdout: string;
  stderr: string;
  snapshotDiff: string;
  errors: string[];
};

export const appControlContract = oc
  .errors({ [RequestRejectedError.code]: RequestRejectedError })
  .router({
    exec: oc.input(type<{ source: string }>()).output(type<BrowserExecution>()),
    snapshot: oc.output(type<BrowserSnapshot>()),
    screenshot: oc.output(type<{ path: string }>()),
  });

export type AppControlClient = RouterContractClient<typeof appControlContract>;
