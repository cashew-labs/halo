import type { WorkspaceSchema } from "@get-halo/client";
import {
  useTandemQuery,
  type UseTandemQuery,
} from "@tanishqkancharla/tandem-react";

export const useDatabaseQuery: UseTandemQuery<WorkspaceSchema> = useTandemQuery;
