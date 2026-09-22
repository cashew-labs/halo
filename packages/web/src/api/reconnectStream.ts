import * as errore from "errore";

class StreamDisconnectedError extends errore.createTaggedError({
  name: "StreamDisconnectedError",
  message: "$stream stream disconnected.",
}) {}

type ReconnectStreamContext<T> = {
  name: string;
  open: () => Promise<AsyncIterable<T>>;
  onItem: (item: T) => Promise<void> | void;
  onOpen?: () => Promise<void> | void;
  onError?: (error: Error) => void;
  signal: AbortSignal;
};

export function reconnectStream<T>(ctx: ReconnectStreamContext<T>) {
  runReconnectStream(ctx).catch((cause) => {
    if (ctx.signal.aborted) return;
    console.error(
      `${ctx.name} reconnect loop failed:`,
      new StreamDisconnectedError({ stream: ctx.name, cause }),
    );
  });
}

async function runReconnectStream<T>(ctx: ReconnectStreamContext<T>) {
  const disconnected = await consumeStream(ctx).catch(
    (cause) => new StreamDisconnectedError({ stream: ctx.name, cause }),
  );
  if (ctx.signal.aborted) return;
  if (disconnected !== undefined) ctx.onError?.(disconnected);
}

async function consumeStream<T>(ctx: ReconnectStreamContext<T>) {
  const source = await ctx.open();
  if (ctx.onOpen !== undefined) await ctx.onOpen();

  for await (const item of source) {
    if (ctx.signal.aborted) return;
    await ctx.onItem(item);
  }

  return new StreamDisconnectedError({ stream: ctx.name });
}
