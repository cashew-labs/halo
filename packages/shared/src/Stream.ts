import * as errore from "errore";

type StreamSubscriber<T> = (value: T) => void;

export type StreamConsumeOptions = {
  abortSignal?: AbortSignal;
};

export type ReadonlyStream<T> = {
  subscribe(subscriber: StreamSubscriber<T>): () => void;
  consume(options?: StreamConsumeOptions): StreamConsumer<T>;
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

export class Stream<T> implements ReadonlyStream<T> {
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

  project<V>(
    initialState: V,
    reducer: (state: V, value: T) => V,
  ): ReadonlyProjectedStream<V> {
    return new ProjectedStream(this, initialState, reducer);
  }

  consume(options?: StreamConsumeOptions): StreamConsumer<T> {
    return new StreamConsumer(this, options);
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

class ProjectedStream<T, S> implements ReadonlyProjectedStream<S> {
  private readonly subscribers = new Set<StreamSubscriber<S>>();
  private readonly cleanup = new errore.DisposableStack();
  private state: S;

  constructor(
    source: ReadonlyStream<T>,
    initialState: S,
    reducer: (state: S, value: T) => S,
  ) {
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

  project<V>(
    initialState: V,
    reducer: (state: V, value: S) => V,
  ): ReadonlyProjectedStream<V> {
    return new ProjectedStream(this, initialState, reducer);
  }

  consume(options?: StreamConsumeOptions): StreamConsumer<S> {
    return new StreamConsumer(this, options);
  }

  map<U>(transform: (value: S) => U): ReadonlyStream<U> {
    return new MappedStream(this, transform);
  }

  filter<U extends S>(predicate: (value: S) => value is U): ReadonlyStream<U>;
  filter(predicate: (value: S) => boolean): ReadonlyStream<S>;
  filter(predicate: (value: S) => boolean): ReadonlyStream<S> {
    return new FilteredStream(this, predicate);
  }

  [Symbol.dispose](): void {
    this.cleanup.dispose();
    this.subscribers.clear();
  }
}

class MappedStream<T, U> implements ReadonlyStream<U> {
  constructor(
    private readonly source: ReadonlyStream<T>,
    private readonly transform: (value: T) => U,
  ) {}

  subscribe(subscriber: StreamSubscriber<U>): () => void {
    return this.source.subscribe((value) => subscriber(this.transform(value)));
  }

  project<V>(
    initialState: V,
    reducer: (state: V, value: U) => V,
  ): ReadonlyProjectedStream<V> {
    return new ProjectedStream(this, initialState, reducer);
  }

  consume(options?: StreamConsumeOptions): StreamConsumer<U> {
    return new StreamConsumer(this, options);
  }

  map<V>(transform: (value: U) => V): ReadonlyStream<V> {
    return new MappedStream(this, transform);
  }

  filter<V extends U>(predicate: (value: U) => value is V): ReadonlyStream<V>;
  filter(predicate: (value: U) => boolean): ReadonlyStream<U>;
  filter(predicate: (value: U) => boolean): ReadonlyStream<U> {
    return new FilteredStream(this, predicate);
  }
}

class FilteredStream<T, U extends T = T> implements ReadonlyStream<U> {
  constructor(
    private readonly source: ReadonlyStream<T>,
    private readonly predicate: (value: T) => boolean,
  ) {}

  subscribe(subscriber: StreamSubscriber<U>): () => void {
    return this.source.subscribe((value) => {
      if (!this.predicate(value)) return;
      // SAFETY: U is the type selected by the predicate that accepted value.
      subscriber(value as U);
    });
  }

  project<V>(
    initialState: V,
    reducer: (state: V, value: U) => V,
  ): ReadonlyProjectedStream<V> {
    return new ProjectedStream(this, initialState, reducer);
  }

  consume(options?: StreamConsumeOptions): StreamConsumer<U> {
    return new StreamConsumer(this, options);
  }

  map<V>(transform: (value: U) => V): ReadonlyStream<V> {
    return new MappedStream(this, transform);
  }

  filter<V extends U>(predicate: (value: U) => value is V): ReadonlyStream<V>;
  filter(predicate: (value: U) => boolean): ReadonlyStream<U>;
  filter(predicate: (value: U) => boolean): ReadonlyStream<U> {
    return new FilteredStream(this, predicate);
  }
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
