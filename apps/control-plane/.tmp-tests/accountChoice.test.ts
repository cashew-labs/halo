import { expect, test } from "vitest";
import { withAccountChoice } from "../src/integrations/accountChoice.ts";

const google =
  "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&prompt=consent&access_type=offline&state=s";

test("Google always shows its account picker and keeps consent", () => {
  const url = new URL(withAccountChoice(google));
  expect(url.searchParams.get("prompt")).toBe("select_account consent");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("state")).toBe("s");
  expect(url.searchParams.has("login_hint")).toBe(false);
});

test("Google preselects the requested account", () => {
  const url = new URL(withAccountChoice(google, "me@example.com"));
  expect(url.searchParams.get("login_hint")).toBe("me@example.com");
  expect(url.searchParams.get("prompt")).toBe("select_account consent");
});

test("other providers keep their authorization URL", () => {
  const other = "https://login.example.com/authorize?prompt=consent&state=s";
  expect(withAccountChoice(other, "me@example.com")).toBe(other);
});
