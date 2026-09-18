import crypto from "node:crypto";
import http from "node:http";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "3000" },
    "data-dir": { type: "string", default: ".extension-data" },
  },
});
const sockets = new Set();
const server = http.createServer((request, response) => {
  if (request.url !== "/view/") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html>
<title>WebSocket Greeting</title>
<p role="status">Connecting…</p>
<script>
  const status = document.querySelector("[role=status]");
  const socketUrl = new URL("./socket", location.href);
  socketUrl.protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(socketUrl);
  socket.onmessage = (event) => status.textContent = event.data;
  socket.onerror = () => status.textContent = "WebSocket failed";
</script>`);
});
server.on("upgrade", (request, socket) => {
  if (request.url !== "/view/socket") {
    socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
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
  const message = Buffer.from("Hello from WebSocket");
  socket.write(
    Buffer.concat([Buffer.from([0x81, message.byteLength]), message]),
  );
});
server.listen(Number(values.port), "127.0.0.1", () => {
  const address = server.address();
  if (address === null || typeof address === "string") return;
  process.send?.(`http://127.0.0.1:${address.port}/view/`);
});
process.on("message", (message) => {
  if (message !== "shutdown") return;
  for (const socket of sockets) socket.destroy();
  server.close(() => process.disconnect());
});
