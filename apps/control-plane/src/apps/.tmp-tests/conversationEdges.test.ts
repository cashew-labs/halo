import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { m } from "@get-halo/shared/testing";
import { appWorldTest, signIn } from "./appWorld.js";
import { Browser } from "./browser.js";
import { connectPages, startPagesApi } from "./pagesApi.js";

vi.setConfig({ testTimeout: 120_000 });

const router = `
  viewer: os.handler(({ context }) => context.viewer),
  chat: os.handler(({ input, context }) => context.tools.conversation.send({ viewerToken: context.viewer.token, message: input.message, ...(input.conversationId ? { conversationId: input.conversationId } : {}) })),
  history: os.handler(({ input, context }) => context.tools.conversation.history({ viewerToken: context.viewer.token, conversationId: input.conversationId })),
  forgedHistory: os.handler(({ context }) => context.tools.conversation.history({ viewerToken: "1.b3duZXI.forged", conversationId: "00000000-0000-0000-0000-000000000000" })),
  malformed: os.handler(({ context }) => context.tools.conversation.send({ viewerToken: context.viewer.token })),
  unknown: os.handler(({ context }) => context.tools.conversation.delete({ viewerToken: context.viewer.token })),
`;

appWorldTest.extend({ router })("conversation limits, failures and stored history are handled per viewer", async ({ appDataDir, plane, provider, llm }) => {
  const pages = await startPagesApi();
  const visitor = new Browser();
  try {
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
    await owner.rpc.workspace.ensure();
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
    await owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Add", address, arguments: { database: "reading-db", title: "x" } }] });

    // A model error leaves no reply.
    const failing = visitor.api(app.url, "chat", { message: "hello" });
    await llm.respond(m.error("upstream failed"));
    expect((await failing).body).toMatchObject({ ok: false, error: { message: "The assistant could not reply" } });

    // One run per conversation, two per app.
    const first = visitor.api(app.url, "chat", { message: "first" });
    await llm.waitForRequest();
    const second = visitor.api(app.url, "chat", { message: "second" });
    await llm.waitForRequest();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect((await visitor.api(app.url, "chat", { message: "third" })).body).toMatchObject({ ok: false, error: { message: "The app is busy; try again shortly" } });
    // The model calls the bound action, then answers.
    await llm.respond(m.tool.start("addPage", { id: "call", arguments: {} }));
    await llm.respond(m.assistant("Second done."));
    await llm.respond(m.assistant("First done."));
    const [one, two] = await Promise.all([first, second]);
    const conversationId = ((one.body as { data?: { conversationId: string } }).data ?? (two.body as { data: { conversationId: string } }).data).conversationId;
    const again = visitor.api(app.url, "chat", { message: "more", conversationId });
    await llm.waitForRequest();
    expect((await visitor.api(app.url, "chat", { message: "parallel", conversationId })).body).toMatchObject({ ok: false, error: { message: "This conversation is already replying" } });
    await llm.respond(m.assistant("More."));
    await again;
    // History shows only visible text, not tool calls or results.
    const history = (await visitor.api(app.url, "history", { conversationId })).body as { ok: boolean; data: { role: string }[] };
    expect(history.ok).toBe(true);
    expect(history.data.every((message) => message.role === "user" || message.role === "assistant")).toBe(true);
    expect((await visitor.api(app.url, "history", { conversationId: "not-an-id" })).body).toMatchObject({ ok: false, error: { message: "Conversation not found" } });
    expect((await visitor.api(app.url, "forgedHistory")).body).toMatchObject({ ok: false, error: { message: "Viewer token expired" } });
    expect((await visitor.api(app.url, "malformed")).body).toMatchObject({ ok: false, error: { message: "Invalid conversation request" } });
    expect((await visitor.api(app.url, "unknown")).body).toMatchObject({ ok: false, error: { message: "Invalid conversation request" } });
    // A damaged history file is reported, not replaced.
    const viewerId = ((await visitor.api(app.url, "viewer")).body as { viewerId: string }).viewerId;
    const file = path.join(provider.vms.get(app.appId)!.root, "data/app-conversations", crypto.createHash("sha256").update(viewerId).digest("hex"), `${conversationId}.json`);
    await fs.writeFile(file, "{");
    expect((await visitor.api(app.url, "history", { conversationId })).body).toMatchObject({ ok: false, error: { message: "Conversation is unavailable" } });
    await fs.rm(file);
    await fs.mkdir(file);
    expect((await visitor.api(app.url, "history", { conversationId })).body).toMatchObject({ ok: false, error: { message: "Conversation is unavailable" } });
  } finally {
    await visitor.close();
    await pages.close();
  }
});

appWorldTest.extend({ router })("trimmed conversation history keeps whole turns", async ({ appDataDir, plane, provider, llm }) => {
  const pages = await startPagesApi();
  const visitor = new Browser();
  try {
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
    await owner.rpc.workspace.ensure();
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
    await owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Add", address, arguments: { database: "reading-db", title: "x" } }] });
    // Six tool turns store 24 messages; the next plain turn pushes the oldest
    // turn's user message and tool call out of the 24-message window.
    let conversationId: string | undefined;
    const send = async (message: string, tool: boolean) => {
      const reply = visitor.api(app.url, "chat", { message, ...(conversationId === undefined ? {} : { conversationId }) });
      if (tool) await llm.respond(m.tool.start("addPage", { id: `call-${message}`, arguments: {} }));
      await llm.respond(m.assistant(`Reply to ${message}.`));
      const body = (await reply).body as { ok: boolean; data: { conversationId: string } };
      expect(body.ok).toBe(true);
      conversationId = body.data.conversationId;
    };
    for (let turn = 0; turn < 6; turn += 1) await send(`tool ${turn}`, true);
    await send("plain", false);
    const viewerId = ((await visitor.api(app.url, "viewer")).body as { viewerId: string }).viewerId;
    const file = path.join(provider.vms.get(app.appId)!.root, "data/app-conversations", crypto.createHash("sha256").update(viewerId).digest("hex"), `${conversationId}.json`);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as { role: string }[];
    expect(stored[0]?.role).toBe("user");
    expect(stored).toHaveLength(22);
    // The next request sends no tool result without its call.
    const next = visitor.api(app.url, "chat", { message: "after", conversationId });
    await llm.respond((body) => {
      const sent = body.messages as { role: string; tool_calls?: unknown[] }[];
      const firstTool = sent.findIndex((message) => message.role === "tool");
      expect(sent.slice(0, firstTool).some((message) => message.role === "assistant" && (message.tool_calls?.length ?? 0) > 0)).toBe(true);
      expect(sent.find((message) => message.role !== "system")?.role).toBe("user");
      return m.assistant("After.");
    });
    expect((await next).body).toMatchObject({ ok: true });
  } finally {
    await visitor.close();
    await pages.close();
  }
});

appWorldTest.extend({ router })("a single tool-heavy turn longer than the window is stored whole", async ({ appDataDir, plane, provider, llm }) => {
  const pages = await startPagesApi();
  const visitor = new Browser();
  try {
    const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
    await owner.rpc.workspace.ensure();
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
    await owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Add", address, arguments: { database: "reading-db", title: "x" } }] });
    const first = visitor.api(app.url, "chat", { message: "hello" });
    await llm.respond(m.assistant("Hi."));
    const conversationId = ((await first).body as { data: { conversationId: string } }).data.conversationId;
    // Three steps of eight parallel calls: 1 user + 3 × (1 call + 8 results) + 1 reply = 29 messages.
    const heavy = visitor.api(app.url, "chat", { message: "many", conversationId });
    for (let step = 0; step < 3; step += 1)
      await llm.respond(Array.from({ length: 8 }, (_, call) => m.tool.start("addPage", { id: `call-${step}-${call}`, arguments: {} })));
    await llm.respond(m.assistant("Done."));
    expect((await heavy).body).toMatchObject({ ok: true, data: { reply: "Done." } });
    const viewerId = ((await visitor.api(app.url, "viewer")).body as { viewerId: string }).viewerId;
    const file = path.join(provider.vms.get(app.appId)!.root, "data/app-conversations", crypto.createHash("sha256").update(viewerId).digest("hex"), `${conversationId}.json`);
    const stored = JSON.parse(await fs.readFile(file, "utf8")) as { role: string; content: unknown }[];
    expect(stored).toHaveLength(29);
    expect(stored[0]).toMatchObject({ role: "user" });
    expect(JSON.stringify(stored[0]!.content)).toContain("many");
    const history = (await visitor.api(app.url, "history", { conversationId })).body as { data: { role: string; text: string }[] };
    expect(history.data.at(-1)).toEqual({ role: "assistant", text: "Done." });
  } finally {
    await visitor.close();
    await pages.close();
  }
});
