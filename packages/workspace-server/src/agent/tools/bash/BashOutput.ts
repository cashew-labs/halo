import { randomUUID } from "node:crypto";
import { createWriteStream, type WriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { finished } from "node:stream/promises";
import * as errore from "errore";

export class BashOutputError extends errore.createTaggedError({
  name: "BashOutputError",
  message: "Failed to save Bash output",
}) {}

export type BashOutputResult =
  | {
      truncated: false;
      stdout: string;
      stderr: string;
      outputChars: number;
    }
  | {
      truncated: true;
      head: string;
      tail: string;
      outputChars: number;
      fullOutputPath: string;
    };

export class BashOutput {
  private readonly outputFile: string;
  private readonly stream: WriteStream;
  private readonly closed: Promise<void | BashOutputError>;
  private readonly headChars: number;
  private readonly tailChars: number;
  private readonly stdoutDecoder = new StringDecoder("utf8");
  private readonly stderrDecoder = new StringDecoder("utf8");
  private stdout = "";
  private stderr = "";
  private head = "";
  private tail = "";
  private outputChars = 0;
  private removed = false;

  private constructor(input: {
    outputFile: string;
    headChars: number;
    tailChars: number;
    onDrain: () => void;
    onError: (error: BashOutputError) => void;
  }) {
    this.outputFile = input.outputFile;
    this.headChars = input.headChars;
    this.tailChars = input.tailChars;
    this.stream = createWriteStream(input.outputFile, {
      flags: "wx",
      mode: 0o600,
    });
    this.closed = finished(this.stream).catch(
      (cause) => new BashOutputError({ cause }),
    );
    this.stream.on("drain", input.onDrain);
    this.stream.on("error", (cause) =>
      input.onError(new BashOutputError({ cause })),
    );
  }

  static async create(input: {
    directory: string;
    headChars: number;
    tailChars: number;
    onDrain: () => void;
    onError: (error: BashOutputError) => void;
  }) {
    const created = await fs
      .mkdir(input.directory, { recursive: true, mode: 0o700 })
      .catch((cause) => new BashOutputError({ cause }));
    if (created instanceof Error) return created;
    return new BashOutput({
      ...input,
      outputFile: path.join(input.directory, `bash-${randomUUID()}.txt`),
    });
  }

  append(source: "stdout" | "stderr", chunk: Buffer) {
    const decoder =
      source === "stdout" ? this.stdoutDecoder : this.stderrDecoder;
    this.appendText(source, decoder.write(chunk));
    return errore.try({
      try: () => this.stream.write(chunk),
      catch: (cause) => new BashOutputError({ cause }),
    });
  }

  async finish(): Promise<BashOutputResult | BashOutputError> {
    this.appendText("stdout", this.stdoutDecoder.end());
    this.appendText("stderr", this.stderrDecoder.end());
    this.stream.end();
    const closed = await this.closed;
    if (closed instanceof Error) return closed;
    if (this.outputChars > this.headChars + this.tailChars)
      return {
        truncated: true,
        head: this.head,
        tail: this.tail,
        outputChars: this.outputChars,
        fullOutputPath: this.outputFile,
      };

    const removed = await fs
      .unlink(this.outputFile)
      .catch((cause) => new BashOutputError({ cause }));
    if (removed instanceof Error) return removed;
    this.removed = true;
    return {
      truncated: false,
      stdout: this.stdout,
      stderr: this.stderr,
      outputChars: this.outputChars,
    };
  }

  async discard() {
    if (this.removed) return;
    await fs
      .unlink(this.outputFile)
      .catch((cause) =>
        console.warn("Failed to remove incomplete Bash output:", cause),
      );
    this.removed = true;
  }

  private appendText(source: "stdout" | "stderr", text: string) {
    if (text.length === 0) return;
    this.outputChars += text.length;
    if (this.outputChars <= this.headChars + this.tailChars) {
      if (source === "stdout") this.stdout += text;
      else this.stderr += text;
    } else {
      this.stdout = "";
      this.stderr = "";
    }
    if (this.head.length < this.headChars)
      this.head += text.slice(0, this.headChars - this.head.length);
    if (this.tailChars > 0)
      this.tail = `${this.tail}${text}`.slice(-this.tailChars);
  }
}
