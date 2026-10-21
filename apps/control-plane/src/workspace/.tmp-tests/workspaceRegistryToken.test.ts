import { expect, test, vi } from "vitest";
import { GoogleAuth, OAuth2Client } from "google-auth-library";
import { workspaceRegistryToken } from "../workspaceRegistryToken.js";

test.each(["token", "empty", "denied"])(
  "delegates only a short lived repository reader: %s",
  async (result) => {
    const source = new OAuth2Client({
      transporterOptions: {
        fetchImplementation: async (url, options) => {
          expect(String(url)).toContain(
            "iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/reader@example.com:generateAccessToken",
          );
          const payload = JSON.parse(String(options?.body));
          expect(payload).toMatchObject({
            scope: ["https://www.googleapis.com/auth/devstorage.read_only"],
            lifetime: "900s",
          });
          return new Response(
            JSON.stringify(
              result === "denied"
                ? { error: { message: "permission denied" } }
                : {
                    accessToken:
                      result === "token" ? "reader-only-token" : null,
                    expireTime: new Date(Date.now() + 900_000).toISOString(),
                  },
            ),
            {
              status: result === "denied" ? 403 : 200,
              headers: { "content-type": "application/json" },
            },
          );
        },
      },
    });
    source.setCredentials({
      access_token: "host-identity",
      expiry_date: Date.now() + 3600_000,
    });
    const credentials = vi
      .spyOn(GoogleAuth.prototype, "getClient")
      .mockResolvedValue(source);
    try {
      const token = await workspaceRegistryToken("reader@example.com");
      if (result === "token") expect(token).toBe("reader-only-token");
      else expect(token).toBeInstanceOf(Error);
    } finally {
      credentials.mockRestore();
    }
  },
);

test("unavailable host identity is returned as an error", async () => {
  const credentials = vi
    .spyOn(GoogleAuth.prototype, "getClient")
    .mockRejectedValue(new Error("credentials unavailable"));
  try {
    expect(await workspaceRegistryToken("reader@example.com")).toBeInstanceOf(
      Error,
    );
  } finally {
    credentials.mockRestore();
  }
});
