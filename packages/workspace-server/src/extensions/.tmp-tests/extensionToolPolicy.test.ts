import { expect, test } from "vitest";
import { authorizeExtensionTool } from "../extensionToolPolicy.js";

test("extensions use existing connected tools but cannot manage account infrastructure", () => {
  for (const path of ["halo.registerMcp", "halo.registerOpenAPI", "halo.removeConnection", "executor.connections.create", "connections.remove", "policies.create", "oauth.start"])
    expect(authorizeExtensionTool(path)).toBeInstanceOf(Error);
  for (const path of ["integrations.notion.default.query", "files.read", "search", "describe.tool"])
    expect(authorizeExtensionTool(path)).toBeUndefined();
});
