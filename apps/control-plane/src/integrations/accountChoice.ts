// Google signs in with the browser's current account unless asked to show its
// account picker, so a browser signed in to one account can connect another.
export function withAccountChoice(authorizationUrl: string) {
  const url = new URL(authorizationUrl);
  if (url.host !== "accounts.google.com") return authorizationUrl;
  url.searchParams.set("prompt", "select_account consent");
  return url.toString();
}
