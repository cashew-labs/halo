import { expect, test } from "vitest";
import { withAccountChoice } from "../src/integrations/accountChoice.ts";

test("Google always shows its account picker and keeps consent", () => {
  const url = new URL(
    withAccountChoice(
      "https://accounts.google.com/o/oauth2/v2/auth?client_id=x&prompt=consent&access_type=offline&state=s",
    ),
  );
  expect(url.searchParams.get("prompt")).toBe("select_account consent");
  expect(url.searchParams.get("access_type")).toBe("offline");
  expect(url.searchParams.get("state")).toBe("s");
  expect(url.searchParams.has("login_hint")).toBe(false);
});

test("other providers keep their authorization URL", () => {
  const other = "https://login.example.com/authorize?prompt=consent&state=s";
  expect(withAccountChoice(other)).toBe(other);
});
