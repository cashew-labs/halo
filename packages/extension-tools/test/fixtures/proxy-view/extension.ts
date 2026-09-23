import crypto from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { Hono } from "hono";
import {
  defineExtension,
  proxyView,
  type ExtensionEnvironment,
} from "@get-halo/extension-sdk/server";
import { relations, schema } from "./schema.js";

const api = new Hono<ExtensionEnvironment>();

// oxlint-disable-next-line anti-slop/no-unused-exports -- The extension builder imports this fixture entry.
export default defineExtension({
  api,
  schema,
  relations,
  view: proxyView(),

  async serve() {
    const sockets = new Set<import("node:stream").Duplex>();
    const server = http.createServer((request, response) => {
      if (request.url !== "/") {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(`<!doctype html>
<p role="status">Connecting…</p>
<script>
  const status = document.querySelector("[role=status]");
  const socketUrl = new URL("./socket", location.href);
  socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(socketUrl);
  socket.onmessage = (event) => status.textContent = event.data;
</script>`);
    });
    server.on("upgrade", (request, socket) => {
      if (request.url !== "/socket") {
        socket.destroy();
        return;
      }
      const key = request.headers["sec-websocket-key"];
      if (key === undefined || Array.isArray(key)) {
        socket.destroy();
        return;
      }
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      const accept = crypto
        .createHash("sha1")
        .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\n" +
          "Connection: Upgrade\r\n" +
          "Upgrade: websocket\r\n" +
          `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const message = Buffer.from("Hello from proxy view");
      socket.write(
        Buffer.concat([Buffer.from([0x81, message.byteLength]), message]),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    // SAFETY: the callback runs after a numeric TCP listener starts.
    const address = server.address() as AddressInfo;
    return {
      view: {
        target: `http://127.0.0.1:${address.port}`,
        stripPrefix: true,
      },
      async close() {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve, reject) =>
          server.close((error) => {
            if (error !== undefined) {
              reject(error);
              return;
            }
            resolve();
          }),
        );
      },
    };
  },
});
