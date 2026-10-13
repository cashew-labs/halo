import { expect } from "vitest";
import { sessionToolExecutions } from "@get-halo/client";
import { m } from "@get-halo/shared/testing";
import { IntegrationRegistrationError } from "@get-halo/shared/controlPlaneContract";
import { serverTest } from "../serverTest.js";

const mcp = {
  name: "MCP",
  slug: "custom-mcp",
  endpoint: "https://mcp.example/mcp",
  auth: "oauth",
};
const api = {
  name: "API",
  slug: "custom-api",
  url: "https://api.example/openapi.json",
};

serverTest(
  "reports registration unavailability without claiming success",
  async ({ server, llm }) => {
    const session = await server.rpc.thread.new();
    const pending = server.promptAndWait({
      ...session,
      text: "Add these integrations",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "unavailable",
        arguments: {
          js: `[
    await tools.halo.registerMcp(${JSON.stringify(mcp)}),
    await tools.halo.registerOpenAPI(${JSON.stringify(api)})
  ];`,
        },
      }),
    );
    await llm.respond(m.assistant("Registration is unavailable."));
    await pending;
    const executions = sessionToolExecutions(
      await server.rpc.thread.snapshot(session),
    );
    expect(executions).toMatchObject([{ result: { isError: false } }]);
    const text = JSON.stringify(executions[0]?.result?.details);
    expect(text.match(/integrations_unavailable/g)).toHaveLength(2);
    expect(text).not.toContain('"status":"registered"');
  },
);

serverTest(
  "validates registration inputs and returns backend failures with cancellation context",
  async ({ createServer, llm }) => {
    const received: unknown[] = [];
    const signals: (AbortSignal | undefined)[] = [];
    const server = createServer({
      remoteIntegrationTools: {
        registerMcp: async (input, signal) => {
          received.push(input);
          signals.push(signal);
          return new IntegrationRegistrationError({
            cause: new Error("Remote integrations require HTTPS"),
          });
        },
        registerOpenAPI: async (input, signal) => {
          received.push(input);
          signals.push(signal);
          return await Promise.reject(
            input.slug === "opaque-error"
              ? "connection closed"
              : new Error("Unsafe remote URL"),
          ).catch((cause) => new IntegrationRegistrationError({ cause }));
        },
        search: async () => ({ tools: [], truncated: false }),
        describe: async () => new Error("Not connected"),
        invoke: async () => new Error("Not connected"),
      },
    });
    await server.start();
    const session = await server.rpc.thread.new();
    const pending = server.promptAndWait({
      ...session,
      text: "Add these integrations",
    });
    await llm.respond(
      m.tool.start("exec", {
        id: "registration-errors",
        arguments: {
          js: `[
    await tools.halo.registerMcp(${JSON.stringify({ ...mcp, token: "must-not-be-sent" })}),
    await tools.halo.registerMcp(${JSON.stringify({ ...mcp, slug: "INVALID" })}),
    await tools.halo.registerMcp(${JSON.stringify({ ...mcp, auth: "stdio" })}),
    await tools.halo.registerOpenAPI(${JSON.stringify({ ...api, userId: "foreign" })}),
    await tools.halo.registerMcp(${JSON.stringify(mcp)}),
    await tools.halo.registerOpenAPI(${JSON.stringify(api)}),
    await tools.halo.registerOpenAPI(${JSON.stringify({ ...api, slug: "opaque-error" })})
  ];`,
        },
      }),
    );
    await llm.respond(m.assistant("Registration failed."));
    await pending;
    const executions = sessionToolExecutions(
      await server.rpc.thread.snapshot(session),
    );
    expect(executions).toMatchObject([{ result: { isError: false } }]);
    const text = JSON.stringify(executions[0]?.result?.details);
    expect(text.match(/invalid_tool_arguments/g)).toHaveLength(4);
    expect(text.match(/registration_failed/g)).toHaveLength(3);
    expect(text).toContain("Remote integrations require HTTPS");
    expect(text).toContain("Unsafe remote URL");
    expect(text).toContain("Integration registration failed");
    expect(text).not.toContain("startup failed");
    expect(received).toEqual([mcp, api, { ...api, slug: "opaque-error" }]);
    expect(signals).toHaveLength(3);
    expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
  },
);
