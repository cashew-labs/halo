import * as errore from "errore";

class SignInAllowlistError extends errore.createTaggedError({
  name: "SignInAllowlistError",
  message: "Sign-in allowlist $detail",
}) {}

/**
 * Emails allowed to sign in, read from an external source such as a Secret
 * Manager secret so the list lives outside the code. The source lists emails
 * separated by newlines or commas.
 */
export class SignInAllowlist {
  // The last list read successfully; refreshed lazily.
  private emails: ReadonlySet<string> | undefined;
  // When the last read finished, successful or not, so failures back off too.
  private checkedAt = 0;
  // One read at a time; concurrent requests share it.
  private refreshing: Promise<SignInAllowlistError | undefined> | undefined;
  private readonly read: () => Promise<string | Error>;
  private readonly refreshMs: number;
  private readonly timeoutMs: number;
  private readonly now: () => number;

  constructor(ctx: {
    read: () => Promise<string | Error>;
    refreshMs: number;
    timeoutMs?: number;
    now?: () => number;
  }) {
    this.read = ctx.read;
    this.refreshMs = ctx.refreshMs;
    this.timeoutMs = ctx.timeoutMs ?? 5_000;
    this.now = ctx.now ?? Date.now;
  }

  async allows(email: string): Promise<boolean | Error> {
    if (this.refreshing === undefined && this.isStale()) {
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = undefined;
      });
    }
    // Waiting keeps removals immediate; the read timeout bounds the wait, and
    // a failed refresh falls back to the last list read successfully.
    const refreshed = await this.refreshing;
    if (refreshed instanceof Error && this.emails === undefined)
      return refreshed;
    return this.emails?.has(normalize(email)) ?? false;
  }

  private isStale() {
    return (
      this.emails === undefined || this.now() - this.checkedAt >= this.refreshMs
    );
  }

  private async refresh() {
    const source = await this.readWithTimeout();
    this.checkedAt = this.now();
    if (source instanceof Error) {
      const error = new SignInAllowlistError({
        detail: "could not be read",
        cause: source,
      });
      // With a list in hand callers fall back to it, so report the failure here.
      if (this.emails !== undefined) console.error(error);
      return error;
    }
    this.emails = parseEmails(source);
    return undefined;
  }

  private async readWithTimeout() {
    using cleanup = new errore.DisposableStack();
    return await Promise.race([
      this.read(),
      new Promise<Error>((resolve) => {
        const timer = setTimeout(
          () => resolve(new Error(`timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs,
        );
        cleanup.defer(() => clearTimeout(timer));
      }),
    ]);
  }
}

function parseEmails(source: string) {
  return new Set(
    source
      .split(/[\n,]/u)
      .map(normalize)
      .filter((email) => email !== ""),
  );
}

function normalize(email: string) {
  return email.trim().toLowerCase();
}
