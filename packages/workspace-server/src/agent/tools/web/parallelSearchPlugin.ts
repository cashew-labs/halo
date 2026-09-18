import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { type Static, Type } from "@sinclair/typebox";
import * as errore from "errore";
import {
  defineHaloTool,
  type HaloToolContext,
  type HaloToolPlugin,
} from "../HaloToolPlugin.js";

class ParallelMcpError extends errore.createTaggedError({
  name: "ParallelMcpError",
  message: "Parallel MCP request failed",
}) {}

class ParallelMcpToolError extends errore.createTaggedError({
  name: "ParallelMcpToolError",
  message: 'Parallel MCP tool "$tool" failed: $details',
}) {}

const parallelSearchMcpUrl = "https://search.parallel.ai/mcp";

const webSearchParameters = Type.Object({
  objective: Type.String({
    description:
      "Natural-language description of what the web search is trying to find. Keep it atomic. May include preferred sources or freshness.",
  }),
  search_queries: Type.Array(Type.String(), {
    description:
      "Concise keyword search queries, 3-6 words each. At least one is required; provide 2-3 for best results. Batch related angles in one call.",
  }),
});

const webFetchParameters = Type.Object({
  urls: Type.Array(Type.String(), {
    description:
      "HTTP/HTTPS URLs to extract. Up to 20 per request. Use after web.search, or when the user named a URL.",
  }),
  objective: Type.Optional(
    Type.String({
      description:
        "What to extract from the URLs. Limit to 200 characters. Focuses excerpts on the relevant parts.",
    }),
  ),
  search_queries: Type.Optional(
    Type.Array(Type.String(), {
      description:
        "Optional keyword queries used with objective to focus excerpts. Pass queries from the prior web.search when applicable.",
    }),
  ),
  full_content: Type.Optional(
    Type.Boolean({
      description:
        "Leave off unless you need the entire page as markdown. Default excerpts are smaller and usually enough.",
    }),
  ),
});

type ParallelSearchArgs = Static<typeof webSearchParameters>;
type ParallelFetchArgs = Static<typeof webFetchParameters>;

type ParallelMcpCall = {
  objective?: string;
  search_queries?: string[];
  urls?: string[];
  full_content?: boolean;
  session_id: string;
  model_name?: string;
};

let clientPromise: Promise<Client | ParallelMcpError> | undefined;

async function getClient() {
  if (clientPromise === undefined) {
    const client = new Client({ name: "halo", version: "1" });
    clientPromise = client
      .connect(new StreamableHTTPClientTransport(new URL(parallelSearchMcpUrl)))
      .catch((e) => new ParallelMcpError({ cause: e }))
      .then((result) => {
        if (result instanceof Error) {
          clientPromise = undefined;
          return result;
        }
        return client;
      });
  }
  return await clientPromise;
}

async function callParallelTool(args: {
  name: string;
  arguments: ParallelSearchArgs | ParallelFetchArgs;
  context: HaloToolContext;
}) {
  const client = await getClient();
  if (client instanceof Error) return client;

  const toolArguments: ParallelMcpCall = {
    ...args.arguments,
    // Parallel free-tier rate limits by session_id; Halo's user id is that key.
    session_id: args.context.userId,
  };
  if (args.context.modelId !== undefined) {
    toolArguments.model_name = args.context.modelId;
  }

  const result = await client
    .callTool(
      { name: args.name, arguments: toolArguments },
      CallToolResultSchema,
      { signal: args.context.signal },
    )
    .catch((e) => new ParallelMcpError({ cause: e }));
  if (result instanceof Error) return result;

  // SAFETY: callTool was invoked with CallToolResultSchema, so the payload is CallToolResult.
  const callResult = result as CallToolResult;
  const text = callResult.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");
  if (callResult.isError === true) {
    return new ParallelMcpToolError({ tool: args.name, details: text });
  }
  if (callResult.structuredContent !== undefined) {
    return { value: callResult.structuredContent };
  }

  // Parallel serializes Search and Fetch results into MCP text content.
  const parsed = errore.try({
    try: () => {
      const value: unknown = JSON.parse(text);
      return { value };
    },
    catch: (cause) => new ParallelMcpError({ cause }),
  });
  if (parsed instanceof Error) return parsed;
  return parsed;
}

export const parallelSearchPlugin: HaloToolPlugin = {
  id: "web",
  name: "Web Search",
  tools: [
    defineHaloTool({
      name: "search",
      description:
        "Search the live web and return relevant excerpts. Search excerpts are usually enough to answer without fetching each result.",
      inputSchema: webSearchParameters,
      requiredCapabilities: ["network.web.search"],
      execute: async (args, context) =>
        await callParallelTool({
          name: "web_search",
          arguments: args,
          context,
        }),
    }),
    defineHaloTool({
      name: "fetch",
      description:
        "Fetch and extract content from specific web URLs when search excerpts are insufficient or the user named a URL.",
      inputSchema: webFetchParameters,
      requiredCapabilities: ["network.web.search"],
      execute: async (args, context) =>
        await callParallelTool({
          name: "web_fetch",
          arguments: args,
          context,
        }),
    }),
  ],
  close: async () => {
    const pendingClient = clientPromise;
    clientPromise = undefined;
    if (pendingClient === undefined) return;
    const client = await pendingClient;
    if (client instanceof Error) return client;
    return await client
      .close()
      .catch((e) => new ParallelMcpError({ cause: e }));
  },
};
