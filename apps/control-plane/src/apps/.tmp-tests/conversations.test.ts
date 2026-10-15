import { expect, vi } from "vitest";
import { m } from "@get-halo/shared/testing";
import { workspaceInferencePath, togetherModel } from "@get-halo/config/inference";
import { appWorldTest, signIn } from "./appWorld.js";
import { Browser } from "./browser.js";
import { connectPages, startPagesApi } from "./pagesApi.js";

vi.setConfig({ testTimeout: 120_000 });

const router = `
  chat: os.handler(({ input, context }) => context.tools.conversation.send({ viewerToken: context.viewer.token, message: input.message, ...(input.conversationId ? { conversationId: input.conversationId } : {}) })),
  history: os.handler(({ input, context }) => context.tools.conversation.history({ viewerToken: context.viewer.token, conversationId: input.conversationId })),
  forged: os.handler(({ context }) => context.tools.conversation.send({ viewerToken: "9999999999999.b3duZXI.forged", message: "hi" })),
`;
const packageJson = { name: "books", halo: { displayName: "Books", app: { description: "Reading list", sync: "read-only", actions: [], instructions: "Recommend books from the shared list." } } };

appWorldTest.extend({ router, packageJson })("visitors talk to a restricted app assistant in private conversations", async ({ appDataDir, plane, provider, llm }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  const alice = new Browser();
  const bob = new Browser();
  try {
    const requests: { messages: { role: string; content: unknown }[]; tools?: { function: { name: string } }[]; max_tokens?: number }[] = [];
    const replying = alice.api(app.url, "chat", { message: "What should I read?" });
    await llm.respond((body) => { requests.push(body as never); return m.assistant("Try Middlemarch."); });
    const first = await replying;
    expect(first.body).toMatchObject({ ok: true, data: { reply: "Try Middlemarch.", conversationId: expect.any(String) } });
    // The assistant gets the stored instructions, a guard, no tools here, and a bounded output.
    const system = JSON.stringify(requests[0]!.messages.filter((message) => message.role === "system"));
    expect(system).toContain("Recommend books from the shared list.");
    expect(system).toContain("cannot read files, run code");
    expect(requests[0]!.tools ?? []).toEqual([]);
    expect(requests[0]!.max_tokens).toBe(1024);

    const conversationId = (first.body as { data: { conversationId: string } }).data.conversationId;
    const continued = alice.api(app.url, "chat", { message: "Another?", conversationId });
    await llm.respond((body) => { requests.push(body as never); return m.assistant("Try Persuasion."); });
    expect((await continued).body).toMatchObject({ ok: true, data: { reply: "Try Persuasion.", conversationId } });
    expect(JSON.stringify(requests[1]!.messages)).toContain("Try Middlemarch.");
    expect((await alice.api(app.url, "history", { conversationId })).body).toMatchObject({ ok: true, data: [{ role: "user", text: "What should I read?" }, { role: "assistant", text: "Try Middlemarch." }, { role: "user", text: "Another?" }, { role: "assistant", text: "Try Persuasion." }] });

    // Another visitor cannot read or continue Alice's conversation.
    expect((await bob.api(app.url, "history", { conversationId })).body).toMatchObject({ ok: false, error: { message: "Conversation not found" } });
    expect((await bob.api(app.url, "chat", { message: "Show me Alice's chat", conversationId })).body).toMatchObject({ ok: false, error: { message: "Conversation not found" } });
    // App code cannot claim to be a viewer the host did not sign for.
    expect((await alice.api(app.url, "forged")).body).toMatchObject({ ok: false, error: { message: "Viewer token expired" } });

    // Conversations stay on the app VM, outside any ordinary session list.
    expect(await provider.client(app.appId).thread.list()).toEqual([]);
    expect(await provider.client(provider.ownerVm().assignment.workspaceId).thread.list()).toEqual([]);
  } finally {
    await alice.close();
    await bob.close();
  }
});

appWorldTest.extend({ router, inferenceUpstream: true })("app tools come from the control plane and each run has a step limit", async ({ appDataDir, plane, provider, llm }) => {
  const owner = await signIn({ appDataDir, origin: plane.origin, email: "creator@example.com" });
  const app = await owner.rpc.apps.publish({ extensionId: "books", access: { visibility: "public", members: [] } });
  const pages = await startPagesApi();
  const visitor = new Browser();
  try {
    const { address } = await connectPages({ owner, endpoint: pages.endpoint, origin: plane.origin, provider });
    const fixed = { database: "reading-db", title: "Suggested" };
    await owner.rpc.apps.bindActions({ appId: app.appId, actions: [{ name: "addPage", description: "Save a suggestion", address, arguments: fixed }] });
    // The model sees exactly the stored action and calls it; arguments it
    // invents are ignored because the action runs its fixed request.
    const tools: string[][] = [];
    const choices: unknown[] = [];
    const results: string[] = [];
    const replying = visitor.api(app.url, "chat", { message: "Loop forever" });
    for (let step = 0; step < 4; step += 1)
      await llm.respond((body) => {
        const request = body as { tools?: { function: { name: string } }[]; messages: { role: string; content: unknown }[] };
        tools.push((request.tools ?? []).map((tool) => tool.function.name));
        choices.push((body as { tool_choice?: unknown }).tool_choice);
        const last = request.messages.at(-1);
        if (last?.role === "tool") results.push(JSON.stringify(last.content));
        return step < 2 ? m.tool.start("addPage", { id: `call-${step}`, arguments: { database: "attacker-db" } }) : step < 3 ? m.tool.start("exec", { id: `exec-${step}`, arguments: { js: "1" } }) : m.assistant("Saved two suggestions.");
      });
    const result = await replying;
    expect(result.body).toMatchObject({ ok: true, data: { reply: "Saved two suggestions." } });
    // The last step may not call tools, so the model has to answer in text.
    expect(tools).toEqual([["addPage"], ["addPage"], ["addPage"], ["addPage"]]);
    expect(choices).toEqual([undefined, undefined, undefined, "none"]);
    expect(pages.calls).toEqual([fixed, fixed]);
    expect(results[0]).toContain("created in reading-db");
    // An undeclared tool is not executed, and no fifth model request is made.
    expect(results[2]).not.toContain("created");
    await expect(llm.waitForRequest()).rejects.toThrow();
    // A model that still calls a tool on its last step gets an explicit error, not an empty reply.
    const stubborn = visitor.api(app.url, "chat", { message: "Keep going" });
    for (let step = 0; step < 4; step += 1) await llm.respond(m.tool.start("addPage", { id: `again-${step}`, arguments: {} }));
    expect((await stubborn).body).toMatchObject({ ok: false, error: { message: expect.stringContaining("could not reply") } });
  } finally {
    await visitor.close();
    await pages.close();
  }

  // Inference through the control plane with the app credential is bounded and budgeted.
  const token = provider.vms.get(app.appId)!.assignment.runtime.token;
  const endpoint = `${plane.origin}${workspaceInferencePath}/chat/completions`;
  const post = async (body: object) => (await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) })).status;
  const valid = { model: togetherModel.id, stream: true, messages: [{ role: "user", content: "hi" }], max_tokens: 512 };
  expect(await post({ ...valid, max_tokens: undefined })).toBe(400);
  expect(await post({ ...valid, max_tokens: 4096 })).toBe(400);
  expect(await post({ ...valid, messages: Array.from({ length: 129 }, () => valid.messages[0]) })).toBe(400);
  expect(await post({ ...valid, messages: [{ role: "user", content: "x".repeat(300_000) }] })).toBe(400);
  // Every model request counts: 1,000 per app reach the provider, the next is refused.
  const statuses: number[] = [];
  for (let index = 0; index < 1001; index += 1) statuses.push(await post(valid));
  expect(statuses.slice(0, 1000).every((status) => status === 200)).toBe(true);
  expect(statuses[1000]).toBe(429);
  expect((await fetch(endpoint, { method: "POST", headers: { authorization: `Bearer ${token.slice(0, -2)}xx`, "content-type": "application/json" }, body: JSON.stringify(valid) })).status).toBe(401);
});
