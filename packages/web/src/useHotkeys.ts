import { useEffect, useState } from "react";
import type { Hotkey } from "@get-halo/client";
import { useApi } from "./api/ApiProvider.js";
import { reconnectStream } from "./api/reconnectStream.js";

export function useHotkeys() {
  const api = useApi();
  const [hotkeys, setHotkeys] = useState<Hotkey[]>([]);
  useEffect(() => {
    const controller = new AbortController();
    reconnectStream({
      name: "Keyboard shortcuts",
      signal: controller.signal,
      open: async () =>
        await api.hotkeys.watch(undefined, { signal: controller.signal }),
      onItem: setHotkeys,
    });
    return () => controller.abort();
  }, [api]);
  return hotkeys;
}
