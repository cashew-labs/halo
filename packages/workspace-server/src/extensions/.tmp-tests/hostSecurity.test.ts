import fs from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { once } from "node:events";
import { WebSocket } from "ws";
import { expect } from "vitest";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { serverTest } from "../../../test/serverTest.js";

serverTest("hosted extension authenticates proxy requests, rejects forged viewers and revokes old tool tokens", async ({ server }) => {
  const directory = path.join(server.workspaceRoot, ".halo/extensions/sample");
  await fs.mkdir(path.join(directory, "dist/public"), { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ name: "sample" }));
  await fs.writeFile(path.join(directory, "dist/public/index.html"), "<html><head></head><body>Sample app</body></html>");
  await fs.writeFile(path.join(server.workspaceRoot, "hello.txt"), "owner notes");
  const sdk = path.resolve(import.meta.dirname, "../../../../extension-sdk/src");
  await build({ bundle: true, platform: "node", format: "esm", target: "node22", outfile: path.join(directory, "dist/start.mjs"), stdin: { resolveDir: sdk, contents: `
    import { runExtension } from ${JSON.stringify(path.join(sdk, "server.ts"))};
    import { os } from ${JSON.stringify(path.join(sdk, "api.ts"))};
    import { defineSchema, defineRelations } from ${JSON.stringify(path.join(sdk, "schema.ts"))};
    const schema = defineSchema({});
    await runExtension({ schema, relations: defineRelations(schema, () => ({})), publicDirectory: ${JSON.stringify(path.join(directory, "dist/public"))}, router: {
      viewer: os.handler(({ context }) => context.viewer),
      readOwn: os.handler(({ context }) => context.tools.files.read({ path: "hello.txt" })),
      manage: os.handler(({ context }) => context.tools.halo.removeConnection({ integration: "notion", name: "default" })),
      token: os.handler(() => process.env.HALO_EXTENSION_TOOLS_TOKEN),
    }});
  ` } });
  await server.rpc.extensions.reload();
  const [extension] = await server.rpc.extensions.list();
  expect(extension?.id).toBe("sample");
  expect((await fetch(extension!.url)).status).toBe(401);
  const headers = { ...server.transport.headers, "x-halo-viewer-id": "forged", "x-halo-viewer-role": "public", "x-halo-viewer-email": "forged@example.com", "x-halo-extension-token": "forged" };
  const api = createORPCClient<{ viewer(): Promise<{ viewerId: string; role: string }>; readOwn(): Promise<{ ok: boolean }>; manage(): Promise<{ ok: boolean; error: { message: string } }>; token(): Promise<string> }>(new RPCLink({ origin: server.transport.origin, url: "/extensions/sample/api", headers }));
  expect(await api.viewer()).toMatchObject({ viewerId: "owner", role: "owner" });
  expect((await fetch(`${server.transport.origin}/extensions/sample/view/`, { headers })).status).toBe(200);
  expect(await api.readOwn()).toMatchObject({ ok: true });
  expect(await api.manage()).toMatchObject({ ok: false });
  const oldToken = await api.token();
  await server.rpc.extensions.restart({ id: "sample" });
  const oldTools = createORPCClient<{ invoke(input: { path: string; input: unknown }): Promise<unknown> }>(new RPCLink({ origin: server.transport.origin, url: "/extension-tools", headers: { authorization: `Bearer ${oldToken}` } }));
  await expect(oldTools.invoke({ path: "files.read", input: { path: "hello.txt" } })).rejects.toMatchObject({ data: { status: 401 } });
  await fs.rm(directory, { recursive: true });
  await server.rpc.extensions.reload();
  expect(await server.rpc.extensions.list()).toEqual([]);
});

serverTest("extension WebSocket upgrades carry host authentication and gateway-verified viewer identity", async ({ createServer }) => {
  const server = createServer({ gateway: { token: "gateway-secret-longer-than-32-characters" } });
  await server.start();
  const directory = path.join(server.workspaceRoot, ".halo/extensions/socket");
  await fs.mkdir(path.join(directory, "dist"), { recursive: true });
  await fs.writeFile(path.join(directory, "package.json"), '{"name":"socket"}');
  await fs.writeFile(path.join(directory, "dist/start.mjs"), `
    import http from "node:http";
    import crypto from "node:crypto";
    const server = http.createServer((_req, res) => res.end("socket app"));
    server.on("upgrade", (req, socket) => {
      if (req.headers["x-halo-extension-token"] !== process.env.HALO_EXTENSION_HOST_TOKEN) { socket.end("HTTP/1.1 401 Unauthorized\\r\\n\\r\\n"); return; }
      const accept = crypto.createHash("sha1").update(req.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
      socket.write("HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: " + accept + "\\r\\n\\r\\n");
      const body = Buffer.from(JSON.stringify({ role: req.headers["x-halo-viewer-role"], viewerId: req.headers["x-halo-viewer-id"], email: req.headers["x-halo-viewer-email"] }));
      socket.write(Buffer.concat([Buffer.from([129, body.length]), body]));
    });
    server.listen(0, "127.0.0.1", () => process.send("http://127.0.0.1:" + server.address().port + "/view/"));
    process.on("message", () => process.exit());
  `);
  await server.rpc.extensions.reload();
  for (const fromGateway of [false, true]) {
    const headers = { authorization: fromGateway ? "Bearer gateway-secret-longer-than-32-characters" : server.transport.headers.authorization, "x-halo-viewer-id": "member-id", "x-halo-viewer-role": "member", "x-halo-viewer-email": "member@example.com", "x-halo-extension-token": "forged" };
    const socket = new WebSocket(`${server.transport.origin.replace("http:", "ws:")}/extensions/socket/view/`, { headers });
    const [data] = await once(socket, "message");
    expect(JSON.parse(data.toString())).toEqual(fromGateway ? { role: "member", viewerId: "member-id", email: "member@example.com" } : { role: "owner", viewerId: "owner" });
    socket.terminate();
  }
});
