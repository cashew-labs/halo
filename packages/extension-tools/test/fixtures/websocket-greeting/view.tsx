import { useEffect, useState } from "react";
import { MauiProvider, Text } from "maui";
import type { ExtensionViewProps } from "@get-halo/extension-sdk/view";
import type extension from "./extension.js";
import type { relations, schema } from "./schema.js";

export default function WebSocketGreeting({
  api,
}: ExtensionViewProps<typeof extension, typeof schema, typeof relations>) {
  const [message, setMessage] = useState("Connecting…");

  useEffect(() => {
    const socket = api.events.$ws();
    const receive = (event: MessageEvent) => setMessage(String(event.data));
    const fail = () => setMessage("WebSocket failed");
    socket.addEventListener("message", receive);
    socket.addEventListener("error", fail);
    return () => {
      socket.removeEventListener("message", receive);
      socket.removeEventListener("error", fail);
      socket.close();
    };
  }, [api]);

  return (
    <MauiProvider>
      <Text role="status">{message}</Text>
    </MauiProvider>
  );
}
