import { useEffect, useState } from "react";
import type { hc } from "hono/client";
import type {
  AnyRelations,
  AnySchema,
  RelationalQuery,
  RuntimeSchemaDefinition,
  TandemClient,
} from "@tanishqkancharla/tandem-core";
import type { ExtensionWithApi, InferExtensionApi } from "./definition.js";

type InferSchema<Definition> =
  Definition extends RuntimeSchemaDefinition<infer Schema> ? Schema : never;
export type ExtensionViewProps<
  Definition extends ExtensionWithApi,
  SchemaDefinition extends RuntimeSchemaDefinition,
  Relations extends AnyRelations<InferSchema<SchemaDefinition>>,
> = {
  api: ReturnType<typeof hc<InferExtensionApi<Definition>>>;
  storage: TandemClient<InferSchema<SchemaDefinition>, Relations>;
};

export function useQuery<
  Schema extends AnySchema,
  Relations extends AnyRelations<Schema>,
  Query extends RelationalQuery<Schema, Relations>,
>(storage: TandemClient<Schema, Relations>, query: Query) {
  const [rows, setRows] = useState(() => storage.query(query));
  useEffect(() => {
    const subscription = storage.subscribe(query, setRows);
    // Tandem returns the initial snapshot separately from subsequent subscription notifications.
    // oxlint-disable-next-line react/set-state-in-effect
    setRows(subscription.result);
    return subscription.destroy;
  }, [storage, query]);
  return rows;
}
