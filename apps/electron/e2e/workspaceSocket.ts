import type { PeerResponseMessage } from "@standardserver/peer";
import type { Page } from "@playwright/test";
import { decodePeerMessage, isPeerRequestMessage } from "@standardserver/peer";

type WorkspaceRequest = {
  path: string;
  body: unknown;
  continue(): void;
  fulfill(body: PeerResponseMessage["json"]["body"]): void;
};

/** Intercept the public RPC wire protocol while forwarding all other traffic. */
export async function routeWorkspaceRpc(
  page: Page,
  handle: (request: WorkspaceRequest) => void | Promise<void>,
) {
  await page.routeWebSocket("**/rpc/socket", (socket) => {
    const server = socket.connectToServer();
    socket.onMessage(async (wire) => {
      const decoded = decodePeerMessage(
        Buffer.isBuffer(wire) ? Uint8Array.from(wire) : wire,
      );
      if (!decoded.matched || !isPeerRequestMessage(decoded.message)) {
        server.send(wire);
        return;
      }
      const message = decoded.message;
      await handle({
        path: new URL(message.json.url, "http://workspace").pathname,
        body: message.json.body,
        continue: () => server.send(wire),
        fulfill: (body) => {
          const encoded = JSON.stringify({
            id: message.id,
            kind: "response",
            json: {
              status: 200,
              headers: { "content-type": "application/json" },
              body,
            },
          });
          socket.send(encoded);
        },
      });
    });
  });
}
