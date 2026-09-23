import { Hono } from "hono";
import {
  defineExtension,
  reactView,
  type ExtensionEnvironment,
} from "@get-halo/extension-sdk/server";
import { relations, schema } from "./schema.js";

const api = new Hono<ExtensionEnvironment>().get("/title", (context) =>
  context.json({ title: "Shared tasks" }),
);

export default defineExtension({
  api,
  schema,
  relations,
  view: reactView("./view.tsx"),
});
