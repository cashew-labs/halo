// Google signs in with the browser's current account unless asked to show its
// account picker. The requested account is preselected but not required.
export function withAccountChoice(authorizationUrl: string, account?: string) {
  const url = new URL(authorizationUrl);
  if (url.host !== "accounts.google.com") return authorizationUrl;
  url.searchParams.set("prompt", "select_account consent");
  if (account !== undefined) url.searchParams.set("login_hint", account);
  return url.toString();
}
