import { APIError } from "better-auth/api";
import type { SignInAllowlist } from "./SignInAllowlist.js";

// Checking both creates covers new sign-ups and existing accounts, in the
// browser and through the desktop's token exchange.
export function signInHooks(ctx: {
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
          await requireAllowed(allowlist, user.email);
        },
      },
    },
    session: {
      create: {
        before: async (session: { userId: string }) => {
          await requireAllowed(
            allowlist,
            await ctx.findUserEmail(session.userId),
          );
        },
      },
    },
  };
}

async function requireAllowed(
  allowlist: SignInAllowlist,
  email: string | undefined | Error,
) {
  if (email instanceof Error) console.error(email);
  const allowed =
    email === undefined || email instanceof Error
      ? false
      : await allowlist.allows(email);
  if (allowed instanceof Error) console.error(allowed);
  if (allowed !== true)
    // The code makes the OAuth callback redirect to its error URL, which the
    // desktop sign-in forwards to the app, instead of answering raw JSON.
    throw APIError.from("FORBIDDEN", {
      code: "NOT_INVITED",
      message: "This Halo deployment is limited to invited accounts",
    });
}
