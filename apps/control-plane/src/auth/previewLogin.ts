import { APIError, createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import * as errore from "errore";

class PreviewLoginError extends errore.createTaggedError({
  name: "PreviewLoginError",
  message: "Preview sign-in failed: $operation",
}) {}

/** Registered only by an explicitly enabled local development host. */
export function previewLogin() {
  return {
    id: "halo-preview-login",
    endpoints: {
      previewLogin: createAuthEndpoint(
        "/preview-login",
        { method: "GET" },
        async (ctx) => {
          ctx.setHeader("cache-control", "no-store");
          const adapter = ctx.context.internalAdapter;
          const existing = await adapter
            .findUserByEmail("preview@halo.local")
            .catch(
              (cause) =>
                new PreviewLoginError({ operation: "find user", cause }),
            );
          if (existing instanceof Error) throw existing;
          const user =
            existing?.user ??
            (await adapter
              .createUser(
                {
                  email: "preview@halo.local",
                  name: "Orb preview",
                  emailVerified: true,
                },
                { method: "email" },
              )
              .catch(
                (cause) =>
                  new PreviewLoginError({ operation: "create user", cause }),
              ));
          if (user instanceof Error) throw user;
          const session = await adapter
            .createSession(user.id)
            .catch(
              (cause) =>
                new PreviewLoginError({ operation: "create session", cause }),
            );
          if (session instanceof Error) throw session;
          if (session === null) throw new APIError("INTERNAL_SERVER_ERROR");
          await setSessionCookie(ctx, { session, user });
          // A fixed destination prevents this login route becoming an open redirect.
          throw ctx.redirect("/");
        },
      ),
    },
  };
}
