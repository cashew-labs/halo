import { expect, test } from "vitest";
import { validateAppAccess, validateAppDefinition } from "../extensionSharing.js";

test("authoring can bind a resource, while malformed and duplicate actions are rejected", () => {
  const action = { name: "books", description: "Read Books", address: "notion.default.query", arguments: { database_id: "books" } };
  const definition = { description: "Public books", sync: "read-only", actions: [action] };
  expect(validateAppDefinition(definition)).toEqual(definition);
  expect(validateAppDefinition({ ...definition, actions: [action, action] })).toBeInstanceOf(Error);
  expect(validateAppDefinition({ ...definition, actions: [{ ...action, address: "shell" }] })).toBeInstanceOf(Error);
  expect(validateAppDefinition({ ...definition, sync: "anything" })).toBeInstanceOf(Error);
  expect(validateAppDefinition({ ...definition, ownerToken: "secret" })).toBeInstanceOf(Error);
});

test("invited access normalizes and deduplicates addresses and rejects malformed members", () => {
  expect(validateAppAccess({ visibility: "invited", members: ["Alice@example.com", "alice@example.com"] })).toEqual({ visibility: "invited", members: ["alice@example.com"] });
  expect(validateAppAccess({ visibility: "public", members: [] })).toEqual({ visibility: "public", members: [] });
  expect(validateAppAccess({ visibility: "invited", members: ["bad"] })).toBeInstanceOf(Error);
});
