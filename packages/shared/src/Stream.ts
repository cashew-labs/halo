import * as errore from "errore";

type StreamSubscriber<T> = (value: T) => void;

export type StreamConsumeOptions = {
  abortSignal?: AbortSignal;
};

export type ReadonlyStream<T> = {
  subscribe(subscriber: StreamSubscriber<T>): () => void;
  consume(options?: StreamConsumeOptions): StreamConsumer<T>;
  /**
   * Subscribe immediately with an independent native stream. Slow readers buffer
   * events without backpressuring the source. Cancel to discard and unsubscribe;
   * abort closes the subscription, allowing already queued events to drain.
   */
  toReadableStream(options?: StreamConsumeOptions): ReadableStream<T>;
  project<S>(
    initialState: S,
    reducer: (state: S, value: T) => S,
  ): ReadonlyProjectedStream<S>;
  map<U>(transform: (value: T) => U): ReadonlyStream<U>;
  filter<S extends T>(predicate: (value: T) => value is S): ReadonlyStream<S>;
  filter(predicate: (value: T) => boolean): ReadonlyStream<T>;
};

export type ReadonlyProjectedStream<T> = ReadonlyStream<T> &
  Disposable & {
    readonly latestValue: T;
  };

abstract class BaseStream<T> implements ReadonlyStream<T> {
  abstract subscribe(subscriber: StreamSubscriber<T>): () => void;

  project<V>(
    initialState: V,
    reducer: (state: V, value: T) => V,
  ): ReadonlyProjectedStream<V> {
    return new ProjectedStream(this, initialState, reducer);
  }

  consume(options?: StreamConsumeOptions): StreamConsumer<T> {
    return new StreamConsumer(this, options);
  }

  toReadableStream(options?: StreamConsumeOptions): ReadableStream<T> {
    return createReadableStream({ stream: this, ...options });
  }

  map<U>(transform: (value: T) => U): ReadonlyStream<U> {
    return new MappedStream(this, transform);
  }

  filter<S extends T>(predicate: (value: T) => value is S): ReadonlyStream<S>;
  filter(predicate: (value: T) => boolean): ReadonlyStream<T>;
  filter(predicate: (value: T) => boolean): ReadonlyStream<T> {
    return new FilteredStream(this, predicate);
  }
}

export class Stream<T> extends BaseStream<T> {
  private readonly subscribers = new Set<StreamSubscriber<T>>();

  append(value: T): void {
    for (const subscriber of this.subscribers) {
      subscriber(value);
    }
  }

  subscribe(subscriber: StreamSubscriber<T>): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }
}

/** Emits the latest values whenever any source changes, after every source is ready. */
export function combineLatest<T>(
  sources: readonly ReadonlyStream<T>[],
): ReadonlyStream<readonly T[]> {
  return new CombinedStream({ sources });
}

class CombinedStream<T> extends BaseStream<readonly T[]> {
  private readonly sources: readonly ReadonlyStream<T>[];

  constructor(ctx: { sources: readonly ReadonlyStream<T>[] }) {
    super();
    this.sources = ctx.sources;
  }

  override subscribe(subscriber: StreamSubscriber<readonly T[]>) {
    const values: T[] = [];
    const received = new Set<number>();
    using cleanup = new errore.DisposableStack();
    for (const [index, source] of this.sources.entries()) {
      cleanup.defer(
        source.subscribe((value) => {
          values[index] = value;
          received.add(index);
          if (received.size === this.sources.length) subscriber([...values]);
        }),
      );
    }
    if (this.sources.length === 0) subscriber([]);
    const owned = cleanup.move();
    return () => owned.dispose();
  }
}

class ProjectedStream<T, S>
  extends BaseStream<S>
  implements ReadonlyProjectedStream<S>
{
  private readonly subscribers = new Set<StreamSubscriber<S>>();
  private readonly cleanup = new errore.DisposableStack();
  private state: S;

  constructor(
    source: ReadonlyStream<T>,
    initialState: S,
    reducer: (state: S, value: T) => S,
  ) {
    super();
    this.state = initialState;
    this.cleanup.defer(
      source.subscribe((value) => {
        this.state = reducer(this.state, value);
        for (const subscriber of this.subscribers) subscriber(this.state);
      }),
    );
  }

  get latestValue(): S {
    return this.state;
  }

  subscribe(subscriber: StreamSubscriber<S>): () => void {
    if (this.cleanup.disposed) return () => {};
    this.subscribers.add(subscriber);
    try {
      subscriber(this.state);
    } catch (error) {
      this.subscribers.delete(subscriber);
      throw error;
    }
    return () => this.subscribers.delete(subscriber);
  }

  [Symbol.dispose](): void {
    this.cleanup.dispose();
    this.subscribers.clear();
  }
}

class MappedStream<T, U> extends BaseStream<U> {
  constructor(
    private readonly source: ReadonlyStream<T>,
    private readonly transform: (value: T) => U,
  ) {
    super();
  }

  subscribe(subscriber: StreamSubscriber<U>): () => void {
    return this.source.subscribe((value) => subscriber(this.transform(value)));
  }
}

class FilteredStream<T, U extends T = T> extends BaseStream<U> {
  constructor(
    private readonly source: ReadonlyStream<T>,
    private readonly predicate: (value: T) => boolean,
  ) {
    super();
  }

  subscribe(subscriber: StreamSubscriber<U>): () => void {
    return this.source.subscribe((value) => {
      if (!this.predicate(value)) return;
      // SAFETY: U is the type selected by the predicate that accepted value.
      subscriber(value as U);
    });
  }
}

function createReadableStream<T>({
  stream,
  abortSignal,
}: StreamConsumeOptions & { stream: ReadonlyStream<T> }) {
  const cleanup = new errore.DisposableStack();
  return new ReadableStream<T>({
    start(controller) {
      if (abortSignal?.aborted) {
        controller.close();
        return;
      }
      cleanup.defer(stream.subscribe((value) => controller.enqueue(value)));
      const abort = () => {
        cleanup.dispose();
        controller.close();
      };
      abortSignal?.addEventListener("abort", abort, { once: true });
      cleanup.defer(() => abortSignal?.removeEventListener("abort", abort));
    },
    cancel() {
      cleanup.dispose();
    },
  });
}

export class StreamConsumer<T>
  implements AsyncIterableIterator<T, void>, Disposable, AsyncDisposable
{
  private readonly values: IteratorResult<T, void>[] = [];
  private readonly readers: ((result: IteratorResult<T, void>) => void)[] = [];
  private readonly cleanup = new errore.DisposableStack();

  constructor(stream: ReadonlyStream<T>, options?: StreamConsumeOptions) {
    const signal = options?.abortSignal;
    if (signal?.aborted) {
      this.cleanup.dispose();
      return;
    }
    this.cleanup.defer(
      stream.subscribe((value) => {
        const result: IteratorResult<T, void> = { done: false, value };
        const reader = this.readers.shift();
        if (reader === undefined) {
          this.values.push(result);
          return;
        }
        reader(result);
      }),
    );
    const abort = () => this[Symbol.dispose]();
    signal?.addEventListener("abort", abort, { once: true });
    this.cleanup.defer(() => signal?.removeEventListener("abort", abort));
  }

  async next(): Promise<IteratorResult<T, void>> {
    if (this.cleanup.disposed)
      return await Promise.resolve({ done: true, value: undefined });
    const value = this.values.shift();
    if (value !== undefined) return await Promise.resolve(value);
    return await new Promise((resolve) => this.readers.push(resolve));
  }

  async return(): Promise<IteratorResult<T, void>> {
    this[Symbol.dispose]();
    return await Promise.resolve({ done: true, value: undefined });
  }

  [Symbol.asyncIterator](): this {
    return this;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this[Symbol.dispose]();
  }

  [Symbol.dispose](): void {
    this.cleanup.dispose();
    this.values.length = 0;
    for (const resolve of this.readers.splice(0))
      resolve({ done: true, value: undefined });
  }
}
