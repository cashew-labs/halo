export type LogLevel = "debug" | "info" | "warn" | "log" | "error";

export type LoggerValue =
  | string
  | number
  | boolean
  | bigint
  | Error
  | readonly LoggerValue[]
  | { readonly [key: string]: LoggerValue };

export type LoggerData = {
  readonly [key: string]: LoggerValue;
};

export type LoggerScope = {
  readonly name: string;
  readonly data: LoggerData;
};

export type LoggerEntry = {
  timestamp: string;
  level: LogLevel;
  scopes: readonly LoggerScope[];
  data: LoggerData;
};

export type LoggerSinkApi = {
  log: (entry: LoggerEntry) => void;
  flush?: () => Promise<void>;
  destroy?: () => void;
};

export type LoggerApi = {
  debug: (data: LoggerData) => void;
  info: (data: LoggerData) => void;
  warn: (data: LoggerData) => void;
  log: (data: LoggerData) => void;
  error: (data: LoggerData) => void;
  flush: () => Promise<void>;
};

type LoggerArgs = {
  sinks?: readonly LoggerSinkApi[];
  scopes?: readonly LoggerScope[];
};

function createLogEntry(
  level: LogLevel,
  scopes: readonly LoggerScope[],
  data: LoggerData,
): LoggerEntry {
  return {
    timestamp: new Date().toISOString(),
    level,
    scopes,
    data,
  };
}

export class Logger implements LoggerApi {
  private readonly sinks: readonly LoggerSinkApi[];
  private readonly scopes: readonly LoggerScope[];

  constructor({ sinks = [], scopes = [] }: LoggerArgs = {}) {
    this.sinks = sinks;
    this.scopes = scopes;
  }

  debug(data: LoggerData) {
    this.write({ level: "debug", data });
  }

  info(data: LoggerData) {
    this.write({ level: "info", data });
  }

  warn(data: LoggerData) {
    this.write({ level: "warn", data });
  }

  log(data: LoggerData) {
    this.write({ level: "log", data });
  }

  error(data: LoggerData) {
    this.write({ level: "error", data });
  }

  scope(name: string, data: LoggerData = {}): Logger {
    return new Logger({
      sinks: this.sinks,
      scopes: [...this.scopes, { name, data }],
    });
  }

  addSink(sink: LoggerSinkApi): Logger {
    return new Logger({
      sinks: [...this.sinks, sink],
      scopes: this.scopes,
    });
  }

  async flush() {
    await Promise.all([...new Set(this.sinks)].map((sink) => sink.flush?.()));
  }

  destroy() {
    for (const sink of new Set(this.sinks)) {
      sink.destroy?.();
    }
  }

  write(
    payload: { level: LogLevel; data: LoggerData },
    extraScopes?: readonly LoggerScope[],
  ) {
    const entry = createLogEntry(
      payload.level,
      extraScopes ? [...this.scopes, ...extraScopes] : this.scopes,
      payload.data,
    );
    for (const sink of this.sinks) {
      sink.log(entry);
    }
  }
}
