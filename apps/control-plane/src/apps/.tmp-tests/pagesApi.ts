import http from "node:http";
import events from "node:events";
import type { AddressInfo } from "node:net";
import { Server as McpServer } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { createControlPlaneRpcClient, type signIn, type VmProvider } from "./appWorld.js";

// The external Notion-like API: records which database each page was added to.
export async function startPagesApi() {
  const calls: unknown[] = [];
  const inputSchema = { type: "object", properties: { database: { type: "string" }, title: { type: "string" } }, required: ["database", "title"] };
  const server = http.createServer(async (request, response) => {
    const mcp = new McpServer({ name: "pages", version: "1" }, { capabilities: { tools: {} } });
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "create_page", description: "Create a page", inputSchema }] }));
    mcp.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
      calls.push(params.arguments);
      if (params.arguments?.database === "failing-db") return { isError: true, content: [{ type: "text", text: "database unavailable" }] };
      return { content: [{ type: "text", text: `created in ${String(params.arguments?.database)}` }] };
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await mcp.connect(transport);
    await transport.handleRequest(request, response);
    response.once("close", () => void mcp.close());
  });
  server.listen(0, "127.0.0.1");
  await events.once(server, "listening");
  const address = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${address.port}/mcp`, calls, close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } };
}


/** The owner connects the pages service and resolves the tool's address. */
export async function connectPages(ctx: { owner: Awaited<ReturnType<typeof signIn>>; endpoint: string; origin: string; provider: VmProvider }) {
  await ctx.owner.rpc.integrations.registerMcp({ name: "Pages", slug: "pages", endpoint: ctx.endpoint, auth: "none" });
  const setup = await ctx.owner.rpc.integrations.startSetup({ integration: "pages", connectionName: "main" });
  await ctx.owner.rpc.integrations.submitSetup({ setupId: setup.setupId, template: "none", values: {} });
  const runtime = createControlPlaneRpcClient(ctx.origin, ctx.provider.ownerVm().assignment.runtime.token);
  const [tool] = (await runtime.integrations.search({ query: "create_page", integration: "pages" })).tools;
  return { address: tool!.address, runtime };
}
