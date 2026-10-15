import { expect, test } from "vitest";
import { validateAppAccess, validateAppDefinition } from "../extensionSharing.js";

test("authoring can bind a resource, while malformed and duplicate actions are rejected", () => {
  const action = { name: "books", description: "Read Books", address: "notion.default.query", arguments: { database_id: "books" } };
  const definition = { description: "Public books", sync: "read-only", actions: [action] };
  expect(validateAppDefinition(definition)).toEqual(definition);
  expect(validateAppDefinition({ ...definition, actions: [action, action] })).toBeInstanceOf(Error);
  expect(validateAppDefinition({ ...definition, actions: [{ ...action, address: "shell" }] })).toBeInstanceOf(Error);
  // Halo's own management namespaces are never actions, whatever the shape.
  for (const address of ["executor.coreTools.oauth.start", "executor.integrations.list", "halo.removeConnection.now", "tools.halo.removeConnection", "tools.tools.executor.connections.create", "connections.default.remove", "oauth.google.start"])
    expect(validateAppDefinition({ ...definition, actions: [{ ...action, address }] })).toBeInstanceOf(Error);
  // Real connected tools use the tools.<integration>.… form.
  expect(validateAppDefinition({ ...definition, actions: [{ ...action, address: "tools.private-mcp.user.personal.echo_marker" }] })).not.toBeInstanceOf(Error);
  expect(validateAppDefinition({ ...definition, sync: "anything" })).toBeInstanceOf(Error);
  expect(validateAppDefinition({ ...definition, ownerToken: "secret" })).toBeInstanceOf(Error);
});

test("invited access normalizes and deduplicates addresses and rejects malformed members", () => {
  expect(validateAppAccess({ visibility: "invited", members: ["Alice@example.com", "alice@example.com"] })).toEqual({ visibility: "invited", members: ["alice@example.com"] });
  expect(validateAppAccess({ visibility: "public", members: [] })).toEqual({ visibility: "public", members: [] });
  expect(validateAppAccess({ visibility: "invited", members: ["bad"] })).toBeInstanceOf(Error);
});
