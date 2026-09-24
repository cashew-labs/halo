import type { Env, Schema } from "hono";
import { Hono } from "hono";
import type {
  AnyRelations,
  AnySchema,
  RuntimeSchemaDefinition,
} from "@tanishqkancharla/tandem-core";
import type { ExtensionTools } from "./tools.js";

export type ExtensionEnvironment<Tools = ExtensionTools> = {
  Bindings: {
    dataDirectory: { path: string };
    tools: Tools;
  };
};

export type AnyExtensionApi = Hono<Env, Schema, string>;

export type ReactExtensionView = {
  kind: "react";
  entry: string;
};

export type ProxyExtensionView = {
  kind: "proxy";
};

export type ExtensionView = ReactExtensionView | ProxyExtensionView;

export type ExtensionServeContext = ExtensionEnvironment["Bindings"];

export type ExtensionService = {
  view?: {
    target: string;
    stripPrefix: boolean;
  };
  close?(): Promise<Error | void> | Error | void;
};

export type ExtensionDefinition<
  Api extends AnyExtensionApi,
  DataSchema extends AnySchema,
  Relations extends AnyRelations<DataSchema>,
> = {
  api: Api;
  schema: RuntimeSchemaDefinition<DataSchema>;
  relations: Relations;
  view: ExtensionView;
  serve?(
    context: ExtensionServeContext,
  ): Promise<Error | ExtensionService> | Error | ExtensionService;
};

export type ExtensionWithApi = {
  api: AnyExtensionApi;
};

export type InferExtensionApi<Definition extends ExtensionWithApi> =
  Definition["api"];

export function reactView(entry: string): ReactExtensionView {
  return { kind: "react", entry };
}

export function proxyView(): ProxyExtensionView {
  return { kind: "proxy" };
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
