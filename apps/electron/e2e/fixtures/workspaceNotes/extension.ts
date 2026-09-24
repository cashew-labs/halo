import { Hono } from "hono";
import {
  defineExtension,
  reactView,
  type ExtensionEnvironment,
  type ExtensionToolResult,
} from "@get-halo/extension-sdk/server";
import { relations, schema } from "./schema.js";

type WorkspaceNotesTools = {
  files: {
    read(input: {
      path: string;
    }): Promise<ExtensionToolResult<{ path: string; text: string }>>;
  };
};

const api = new Hono<ExtensionEnvironment<WorkspaceNotesTools>>().get(
  "/notes",
  async (context) => {
    const result = await context.env.tools.files.read({ path: "notes.txt" });
    if (!result.ok) return context.json({ error: result.error.message }, 500);
    return context.json({ text: result.data.text });
  },
);

export default defineExtension({
  api,
  schema,
  relations,
  view: reactView("./view.tsx"),
});
