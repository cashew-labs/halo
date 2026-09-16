import type { ControlPlaneSession } from "@get-halo/shared/controlPlaneContract";
import * as errore from "errore";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import type { DesktopIdentity } from "../DesktopAuthentication.js";

const adcScopes = ["openid", "https://www.googleapis.com/auth/userinfo.email"];

class AdcDesktopIdentityError extends errore.createTaggedError({
  name: "AdcDesktopIdentityError",
  message: "Application Default Credentials could not $operation",
}) {}

export function createAdcDesktopIdentity(): DesktopIdentity {
  const auth = new GoogleAuth({ scopes: adcScopes });
  const tokenInspector = new OAuth2Client();
  const getSession = async () => await readAdcSession({ auth, tokenInspector });

  return { getSession, signIn: getSession };
}

async function readAdcSession(ctx: {
  auth: GoogleAuth;
  tokenInspector: OAuth2Client;
}) {
  const accessToken = await ctx.auth.getAccessToken().catch(
    (cause) =>
      new AdcDesktopIdentityError({
        operation: "get an access token",
        cause,
      }),
  );
  if (accessToken instanceof Error) return accessToken;
  if (accessToken === null || accessToken === undefined)
    return new AdcDesktopIdentityError({ operation: "get an access token" });

  const tokenInfo = await ctx.tokenInspector.getTokenInfo(accessToken).catch(
    (cause) =>
      new AdcDesktopIdentityError({
        operation: "inspect the access token",
        cause,
      }),
  );
  if (tokenInfo instanceof Error) return tokenInfo;

  const email = tokenInfo.email;
  if (email === undefined)
    return new AdcDesktopIdentityError({ operation: "provide an email" });
  const subject = tokenInfo.sub;
  if (subject === undefined)
    return new AdcDesktopIdentityError({
      operation: "provide a stable subject",
    });

  const userId = `google:${subject}`;
  return {
    session: {
      id: `development-adc:${subject}`,
      userId,
      expiresAt: new Date(tokenInfo.expiry_date).toISOString(),
    },
    user: { id: userId, email, name: email },
  } satisfies ControlPlaneSession;
}
