import { expect, test } from "vitest";
import { combineLatest, Stream } from "@get-halo/shared/Stream";

test("native streams subscribe immediately and buffer independently", async () => {
  const source = new Stream<string | undefined>();
  source.append("before subscribing");
  const first = source.toReadableStream();
  const second = source.toReadableStream();
  expect(Object.getPrototypeOf(first)).toBe(ReadableStream.prototype);
  const reader = first.getReader();
  const other = second.getReader();
  source.append("first");
  source.append(undefined);

  await expect(reader.read()).resolves.toEqual({ done: false, value: "first" });
  await expect(reader.read()).resolves.toEqual({
    done: false,
    value: undefined,
  });
  const pending = reader.read();
  await reader.cancel();
  await expect(pending).resolves.toEqual({ done: true, value: undefined });
  source.append("last");

  await expect(other.read()).resolves.toEqual({ done: false, value: "first" });
  await expect(other.read()).resolves.toEqual({
    done: false,
    value: undefined,
  });
  await expect(other.read()).resolves.toEqual({ done: false, value: "last" });
  source.append("discard on cancel");
  await other.cancel();
  await expect(other.read()).resolves.toEqual({ done: true, value: undefined });
});

test("native stream cancellation detaches mapped subscriptions", async () => {
  const source = new Stream<number>();
  const transformed: number[] = [];
  const controller = new AbortController();
  const readable = source
    .map((value) => {
      transformed.push(value);
      return value * 3;
    })
    .toReadableStream({ abortSignal: controller.signal });
  const reader = readable.getReader();
  source.append(2);
  await expect(reader.read()).resolves.toEqual({ done: false, value: 6 });
  await reader.cancel();
  controller.abort();
  source.append(5);
  expect(transformed).toEqual([2]);
});

test("native streams pipe combined projected states through transforms and close on abort", async () => {
  const left = new Stream<number>();
  const right = new Stream<number>();
  using leftState = left.project(2, (_previous, value) => value);
  using rightState = right.project(7, (_previous, value) => value);
  const controller = new AbortController();
  const readable = combineLatest([leftState, rightState])
    .map(([a, b]) => a! + b!)
    .filter((sum) => sum > 10)
    .toReadableStream({ abortSignal: controller.signal });
  const received: number[] = [];
  const piping = readable.pipeTo(
    new WritableStream<number>({
      write(value) {
        received.push(value);
      },
    }),
  );
  left.append(5);
  right.append(1);
  right.append(9);
  controller.abort();
  right.append(20);
  await piping;
  expect(received).toEqual([12, 14]);

  const projection = leftState.toReadableStream();
  const reader = projection.getReader();
  await expect(reader.read()).resolves.toEqual({ done: false, value: 5 });
  await reader.cancel();
});

test("native stream abort closes pending reads and pre-aborted subscriptions do not replay", async () => {
  const source = new Stream<number>();
  using state = source.project(3, (_previous, value) => value);
  const alreadyClosed = state.toReadableStream({
    abortSignal: AbortSignal.abort(),
  });
  await expect(alreadyClosed.getReader().read()).resolves.toEqual({
    done: true,
    value: undefined,
  });

  const controller = new AbortController();
  const reader = source
    .toReadableStream({ abortSignal: controller.signal })
    .getReader();
  const pending = [reader.read(), reader.read()];
  controller.abort();
  source.append(8);
  await expect(Promise.all(pending)).resolves.toEqual([
    { done: true, value: undefined },
    { done: true, value: undefined },
  ]);
});

test("consume accepts optional options and stops when aborted", async () => {
  const stream = new Stream<number>();
  const abortController = new AbortController();
  using values = stream
    .map((value) => value * 2)
    .filter((value) => value > 2)
    .consume({ abortSignal: abortController.signal });

  const first = values.next();
  stream.append(1);
  stream.append(2);
  await expect(first).resolves.toEqual({ done: false, value: 4 });

  const finished = values.next();
  abortController.abort();
  await expect(finished).resolves.toEqual({ done: true, value: undefined });

  stream.append(3);
  await expect(values.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

test("consume buffers immediately and delivers buffered and pending reads in order", async () => {
  const stream = new Stream<string | undefined>();
  stream.append("before subscribing");
  using values = stream.consume();
  stream.append("ready");
  stream.append(undefined);

  await expect(values.next()).resolves.toEqual({ done: false, value: "ready" });
  await expect(values.next()).resolves.toEqual({
    done: false,
    value: undefined,
  });

  const reads = [values.next(), values.next()];
  stream.append("first");
  stream.append("second");
  await expect(Promise.all(reads)).resolves.toEqual([
    { done: false, value: "first" },
    { done: false, value: "second" },
  ]);
});

test("plain streams remain event-only", () => {
  const stream = new Stream<number>();
  stream.append(1);
  const values: number[] = [];
  stream.subscribe((value) => values.push(value));

  expect(values).toEqual([]);
  stream.append(2);
  expect(values).toEqual([2]);
});

test("projects eagerly and replays the current value to late subscribers", () => {
  const source = new Stream<number>();
  using totals = source.project(0, (sum, value) => sum + value);

  source.append(1);
  source.append(2);
  expect(totals.latestValue).toBe(3);

  const values: number[] = [];
  totals.subscribe((value) => values.push(value));
  expect(values).toEqual([3]);

  source.append(4);
  expect(values).toEqual([3, 7]);
  expect(totals.latestValue).toBe(7);
});

test("reduces each source event once for all listeners", () => {
  const source = new Stream<number>();
  let reductions = 0;
  using totals = source.project(0, (sum, value) => {
    reductions += 1;
    return sum + value;
  });
  const first: number[] = [];
  const second: number[] = [];
  totals.subscribe((value) => first.push(value));
  totals.subscribe((value) => second.push(value));

  source.append(3);
  source.append(4);

  expect(reductions).toBe(2);
  expect(first).toEqual([0, 3, 7]);
  expect(second).toEqual([0, 3, 7]);
});

test("disposal detaches a projection and releases its listeners", () => {
  const source = new Stream<number>();
  const totals = source.project(0, (sum, value) => sum + value);
  const values: number[] = [];
  totals.subscribe((value) => values.push(value));
  source.append(1);

  totals[Symbol.dispose]();
  source.append(2);
  totals.subscribe((value) => values.push(value));

  expect(totals.latestValue).toBe(1);
  expect(values).toEqual([0, 1]);
});

test("consumes projected states until the consumer is aborted", async () => {
  const source = new Stream<number>();
  using totals = source.project(0, (sum, value) => sum + value);
  const controller = new AbortController();
  using values = totals.consume({ abortSignal: controller.signal });
  await expect(values.next()).resolves.toEqual({ done: false, value: 0 });
  source.append(3);
  const first = values.next();
  await expect(first).resolves.toEqual({ done: false, value: 3 });
  const second = values.next();
  source.append(4);
  await expect(second).resolves.toEqual({ done: false, value: 7 });
  const finished = values.next();
  controller.abort();
  await expect(finished).resolves.toEqual({ done: true, value: undefined });
  source.append(5);
  await expect(values.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

test("projected streams compose with normal stream consumers", () => {
  const source = new Stream<number>();
  using totals = source.project(0, (sum, value) => sum + value);
  const values: number[] = [];
  const stop = totals
    .map((value) => value * 2)
    .filter((value) => value > 2)
    .subscribe((value) => values.push(value));

  source.append(1);
  source.append(2);
  stop();
  source.append(3);

  expect(values).toEqual([6]);
});

test("projection state is current during reentrant events", () => {
  const source = new Stream<number>();
  using totals = source.project(0, (sum, value) => sum + value);
  const values: number[] = [];
  totals.subscribe((value) => {
    values.push(value);
    if (value === 1) source.append(2);
  });

  source.append(1);

  expect(totals.latestValue).toBe(3);
  expect(values).toEqual([0, 1, 3]);
});

test("reducer and replay errors propagate without corrupting projection state", () => {
  const source = new Stream<number>();
  using totals = source.project(0, (sum, value) => {
    if (value < 0) throw new Error("invalid value");
    return sum + value;
  });

  expect(() => source.append(-1)).toThrow("invalid value");
  expect(totals.latestValue).toBe(0);
  expect(() =>
    totals.subscribe(() => {
      throw new Error("replay failed");
    }),
  ).toThrow("replay failed");

  source.append(2);
  expect(totals.latestValue).toBe(2);
});

test("listener errors propagate after the projected state advances", () => {
  const source = new Stream<number>();
  using totals = source.project(0, (sum, value) => sum + value);
  const stop = totals.subscribe((value) => {
    if (value === 1) throw new Error("listener failed");
  });

  expect(() => source.append(1)).toThrow("listener failed");
  expect(totals.latestValue).toBe(1);
  stop();
  source.append(2);
  expect(totals.latestValue).toBe(3);
});

test.each(["return", "dispose", "asyncDispose", "abort"] as const)(
  "%s discards buffered values and finishes every pending read",
  async (action) => {
    const stream = new Stream<string>();
    const controller = new AbortController();
    using buffered = stream.consume({ abortSignal: controller.signal });
    stream.append("unread");
    using waiting = stream.consume({ abortSignal: controller.signal });
    const reads = [waiting.next(), waiting.next()];

    if (action === "return") {
      await buffered.return();
      await waiting.return();
    }
    if (action === "dispose") {
      buffered[Symbol.dispose]();
      waiting[Symbol.dispose]();
    }
    if (action === "asyncDispose") {
      await buffered[Symbol.asyncDispose]();
      await waiting[Symbol.asyncDispose]();
    }
    if (action === "abort") controller.abort();

    await expect(Promise.all(reads)).resolves.toEqual([
      { done: true, value: undefined },
      { done: true, value: undefined },
    ]);
    stream.append("after closing");
    await expect(buffered.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
    await expect(waiting.next()).resolves.toEqual({
      done: true,
      value: undefined,
    });
  },
);

test("breaking iteration closes that consumer while another keeps receiving", async () => {
  const stream = new Stream<number>();
  using first = stream.consume();
  using second = stream.consume();
  stream.append(1);
  for await (const value of first) {
    expect(value).toBe(1);
    break;
  }
  stream.append(2);

  await expect(first.next()).resolves.toEqual({ done: true, value: undefined });
  await expect(second.next()).resolves.toEqual({ done: false, value: 1 });
  await expect(second.next()).resolves.toEqual({ done: false, value: 2 });
});

test("an already-aborted consumer is closed before its first read", async () => {
  const stream = new Stream<number>();
  using values = stream.consume({ abortSignal: AbortSignal.abort() });
  stream.append(1);
  await expect(values.next()).resolves.toEqual({
    done: true,
    value: undefined,
  });
});

// Services replay their current state; changes from either source update the combined view.
test("combines current projected values and removes subscriptions on disposal", () => {
  const threads = new Stream<boolean>();
  const tools = new Stream<boolean>();
  using threadsIdle = threads.project(false, (_previous, idle) => idle);
  using toolsIdle = tools.project(false, (_previous, idle) => idle);
  threads.append(true);
  const allIdle = combineLatest([threadsIdle, toolsIdle])
    .map((values) => values.every(Boolean))
    .project(false, (_previous, idle) => idle);
  expect(allIdle.latestValue).toBe(false);
  tools.append(true);
  expect(allIdle.latestValue).toBe(true);
  threads.append(false);
  expect(allIdle.latestValue).toBe(false);
  allIdle[Symbol.dispose]();
  threads.append(true);
  expect(allIdle.latestValue).toBe(false);
});
