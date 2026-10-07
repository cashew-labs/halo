import { expect, test } from "vitest";
import { Stream } from "@get-halo/shared/Stream";

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

// Services replay their current state; changes from either source update the combined view.
test("combines current projected values and removes subscriptions on disposal", () => {
  const threads = new Stream<boolean>();
  const tools = new Stream<boolean>();
  using threadsIdle = threads.project(false, (_previous, idle) => idle);
  using toolsIdle = tools.project(false, (_previous, idle) => idle);
  threads.append(true);
  const allIdle = Stream.combineLatest([threadsIdle, toolsIdle])
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
