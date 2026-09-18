import type { Logger } from "@get-halo/logger";
import * as errore from "errore";

const reconnectDelayMs = 1_000;

class StreamDisconnectedError extends errore.createTaggedError({
  name: "StreamDisconnectedError",
  message: "$stream stream disconnected.",
}) {}

type ReconnectStreamContext<T> = {
  name: string;
  logger: Logger;
  open: () => Promise<AsyncIterable<T>>;
  onItem: (item: T) => Promise<void> | void;
  onOpen?: () => Promise<void> | void;
  signal: AbortSignal;
};

export function reconnectStream<T>(ctx: ReconnectStreamContext<T>) {
  runReconnectStream(ctx).catch((cause) => {
    if (ctx.signal.aborted) return;
    ctx.logger.error({
      event: "reconnect-loop-failed",
      stream: ctx.name,
      error: new StreamDisconnectedError({ stream: ctx.name, cause }),
    });
  });
}

async function runReconnectStream<T>(ctx: ReconnectStreamContext<T>) {
  while (!ctx.signal.aborted) {
    const disconnected = await consumeStream(ctx).catch(
      (cause) => new StreamDisconnectedError({ stream: ctx.name, cause }),
    );
    if (ctx.signal.aborted) return;
    if (disconnected === undefined) return;

    ctx.logger.warn({
      event: "stream-disconnected",
      stream: ctx.name,
      error: disconnected,
    });
    await waitForReconnect(ctx.signal);
  }
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

async function waitForReconnect(signal: AbortSignal) {
  await new Promise<void>((resolve) => {
    const finish = () => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = setTimeout(finish, reconnectDelayMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}
