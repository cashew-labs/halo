import { useEffect, useState } from "react";
import type { RouterClient, AnyRouter } from "@orpc/server";
import type {
  AnySchema,
  RelationalQuery,
  RuntimeRelationsDefinition,
  RuntimeSchemaDefinition,
  TandemClient,
} from "@tanishqkancharla/tandem-core";

type InferSchema<Definition> =
  Definition extends RuntimeSchemaDefinition<infer Schema> ? Schema : never;
export type ExtensionViewProps<
  Router extends AnyRouter,
  Definition extends RuntimeSchemaDefinition,
  Relations extends RuntimeRelationsDefinition<InferSchema<Definition>>,
> = {
  api: RouterClient<Router>;
  storage: TandemClient<InferSchema<Definition>, Relations>;
};

export function useQuery<
  Schema extends AnySchema,
  Relations extends RuntimeRelationsDefinition<Schema>,
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
