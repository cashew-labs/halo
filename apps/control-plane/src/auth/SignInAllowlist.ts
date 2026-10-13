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
  // The last list read successfully and when it was read; refreshed lazily.
  private emails: ReadonlySet<string> | undefined;
  private readAt = 0;
  private readonly read: () => Promise<string | Error>;
  private readonly refreshMs: number;
  private readonly now: () => number;

  constructor(ctx: {
    read: () => Promise<string | Error>;
    refreshMs: number;
    now?: () => number;
  }) {
    this.read = ctx.read;
    this.refreshMs = ctx.refreshMs;
    this.now = ctx.now ?? Date.now;
  }

  async allows(email: string): Promise<boolean | Error> {
    if (
      this.emails === undefined ||
      this.now() - this.readAt >= this.refreshMs
    ) {
      const refreshed = await this.refresh();
      // Keep the last good list through a failed refresh; with none, refuse.
      if (refreshed instanceof Error && this.emails === undefined)
        return refreshed;
    }
    return this.emails?.has(normalize(email)) ?? false;
  }

  private async refresh() {
    const source = await this.read();
    if (source instanceof Error)
      return new SignInAllowlistError({
        detail: "could not be read",
        cause: source,
      });
    this.emails = parseEmails(source);
    this.readAt = this.now();
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
