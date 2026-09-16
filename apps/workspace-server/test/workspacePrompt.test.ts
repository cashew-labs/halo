import { expect, test } from "vitest";
import { haloSystemPrompt } from "../src/agent/workspacePrompt.js";

test("tells the agent to return exec results with a web.fetch example", () => {
  const prompt = haloSystemPrompt({
    environment: "local",
    workspaceRoot: "/tmp/ws",
  });

  expect(prompt).toContain(
    `return await tools['web.fetch']({ urls: ["https://example.com"] })`,
  );
  expect(prompt).not.toContain("emit(");
});
