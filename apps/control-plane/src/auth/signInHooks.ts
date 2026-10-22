import { APIError } from "better-auth/api";
import type { LoggerApi } from "@get-halo/logger";
import type { SignInAllowlist } from "./SignInAllowlist.js";

// Checking both creates covers new sign-ups and existing accounts, in the
// browser and through the desktop's token exchange.
export function signInHooks(ctx: {
  logger: LoggerApi;
  allowlist: SignInAllowlist | undefined;
  /** Resolves a session's user; the hook context is absent outside endpoints. */
  findUserEmail(userId: string): Promise<string | undefined | Error>;
}) {
  const { allowlist } = ctx;
  if (allowlist === undefined) return undefined;
  return {
    user: {
      create: {
        before: async (user: { email: string }) => {
          await requireAllowed(allowlist, user.email, ctx.logger);
        },
      },
    },
    session: {
      create: {
        before: async (session: { userId: string }) => {
          await requireAllowed(
            allowlist,
            await ctx.findUserEmail(session.userId),
            ctx.logger,
            session.userId,
          );
        },
      },
    },
  };
}

async function requireAllowed(
  allowlist: SignInAllowlist,
  email: string | undefined | Error,
  logger: LoggerApi,
  userId?: string,
) {
  const identity: Record<string, string> = {};
  if (userId !== undefined) identity.userId = userId;
  if (email instanceof Error)
    logger.error({
      event: "sign-in-user-lookup-failed",
      ...identity,
    });
  const allowed =
    email === undefined || email instanceof Error
      ? false
      : await allowlist.allows(email);
  if (allowed instanceof Error)
    logger.error({
      event: "sign-in-allowlist-check-failed",
      ...identity,
    });
  if (allowed !== true)
    // The code makes the OAuth callback redirect to its error URL, which the
    // desktop sign-in forwards to the app, instead of answering raw JSON.
    throw APIError.from("FORBIDDEN", {
      code: "NOT_INVITED",
      message: "This Halo deployment is limited to invited accounts",
    });
}
