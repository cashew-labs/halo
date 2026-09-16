import { expect, test } from "vitest";
import { haloSystemPrompt } from "../src/agent/workspacePrompt.js";

test("documents the working web.fetch call with urls", () => {
  const prompt = haloSystemPrompt({
    environment: "local",
    workspaceRoot: "/tmp/ws",
  });

  expect(prompt).toContain("tools['web.fetch']");
  expect(prompt).toContain("{ urls:");
  expect(prompt).toContain("web.fetch");
  expect(prompt).toContain(
    `tools['web.fetch']({ urls: ["https://example.com"] })`,
  );
  expect(prompt).not.toMatch(/tools\['web\.fetch'\]\(\{\s*url:/);
});
