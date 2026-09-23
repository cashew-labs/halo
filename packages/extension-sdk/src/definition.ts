import type { Schema } from "hono";
import { Hono } from "hono";
import type {
  AnyRelations,
  AnySchema,
  RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core";
import type { ExtensionTools } from "./tools.js";

export type ExtensionEnvironment = {
  Bindings: {
    tools: ExtensionTools;
  };
};

export type AnyExtensionApi = Hono<ExtensionEnvironment, Schema, string>;

export type ReactExtensionView = {
  kind: "react";
  entry: string;
};

export type ExtensionDefinition<
  Api extends AnyExtensionApi,
  DataSchema extends AnySchema,
  Relations extends AnyRelations<DataSchema>,
> = {
  api: Api;
  schema: RuntimeSchemaDefinition<DataSchema>;
  relations: Relations;
  view: ReactExtensionView;
};

export type ExtensionWithApi = {
  api: AnyExtensionApi;
};

export type InferExtensionApi<Definition extends ExtensionWithApi> =
  Definition["api"];

export function reactView(entry: string): ReactExtensionView {
  return { kind: "react", entry };
}

export function defineExtension<
  const Api extends AnyExtensionApi,
  DataSchema extends AnySchema,
  Relations extends AnyRelations<DataSchema>,
>(
  definition: ExtensionDefinition<Api, DataSchema, Relations>,
): ExtensionDefinition<Api, DataSchema, Relations> {
  return definition;
}
