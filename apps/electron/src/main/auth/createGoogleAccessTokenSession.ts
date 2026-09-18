import * as errore from "errore";
import { GoogleAuth } from "google-auth-library";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const adcScopes = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

const sessionSchema = Type.Object({
  token: Type.String({ minLength: 1 }),
});

class GoogleAccessTokenSessionError extends errore.createTaggedError({
  name: "GoogleAccessTokenSessionError",
  message: "Halo could not $operation with Application Default Credentials",
}) {}

export async function createGoogleAccessTokenSession(ctx: { origin: string }) {
  const accessToken = await new GoogleAuth({ scopes: adcScopes })
    .getAccessToken()
    .catch(
      (cause) =>
        new GoogleAccessTokenSessionError({
          operation: "get an access token",
          cause,
        }),
    );
  if (accessToken instanceof Error) return accessToken;
  if (accessToken === null || accessToken === undefined) {
    return new GoogleAccessTokenSessionError({
      operation: "get an access token",
    });
  }

  const response = await fetch(`${ctx.origin}/api/dev/google-session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ accessToken }),
  }).catch(
    (cause) =>
      new GoogleAccessTokenSessionError({
        operation: "create a control-plane session",
        cause,
      }),
  );
  if (response instanceof Error) return response;
  if (!response.ok) {
    return new GoogleAccessTokenSessionError({
      operation: "create a control-plane session",
    });
  }

  const payload = await response.json().catch(
    (cause) =>
      new GoogleAccessTokenSessionError({
        operation: "read the control-plane session",
        cause,
      }),
  );
  if (payload instanceof Error) return payload;
  if (!Value.Check(sessionSchema, payload)) {
    return new GoogleAccessTokenSessionError({
      operation: "read the control-plane session",
    });
  }

  return { token: payload.token };
}
