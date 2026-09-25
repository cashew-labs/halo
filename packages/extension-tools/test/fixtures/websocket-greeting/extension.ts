import { Hono } from "hono";
import {
  defineExtension,
  reactView,
  upgradeWebSocket,
  type ExtensionEnvironment,
} from "@get-halo/extension-sdk/server";
import { relations, schema } from "./schema.js";

const api = new Hono<ExtensionEnvironment>().get(
  "/events",
  upgradeWebSocket(() => ({
    onOpen(_event, socket) {
      socket.send("Hello from WebSocket");
    },
  })),
);

export default defineExtension({
  api,
  schema,
  relations,
  view: reactView("./view.tsx"),
});
