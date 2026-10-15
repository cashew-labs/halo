import { expect, test, vi } from "vitest";
import { Logger } from "@get-halo/logger";
import { ExtensionHost } from "../ExtensionHost.js";

function host() {
  return new ExtensionHost({ workspaceRoot: "/nonexistent", toolsOrigin: "http://127.0.0.1:1", filesystem: {} as never, logger: new Logger({ sinks: [] }), runtime: { executable: process.execPath, electronRunAsNode: false } });
}

test("viewer tokens name their viewer only while unexpired, unaltered and from this host", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    const extensions = host();
    const token = extensions.issueViewerToken("alice");
    expect(extensions.readViewerToken(token)).toBe("alice");
    // A valid signature over a swapped viewer ID is rejected.
    const [expiry, , signature] = token.split(".");
    expect(extensions.readViewerToken(`${expiry}.${Buffer.from("bob").toString("base64url")}.${signature}`)).toBeUndefined();
    // So is a later expiry under the same signature.
    expect(extensions.readViewerToken(`${Number(expiry) + 1}.${token.split(".")[1]}.${signature}`)).toBeUndefined();
    // Another host's key cannot vouch for this one.
    expect(host().readViewerToken(token)).toBeUndefined();
    vi.setSystemTime(Date.now() + 59 * 60_000);
    expect(extensions.readViewerToken(token)).toBe("alice");
    vi.setSystemTime(Date.now() + 2 * 60_000);
    expect(extensions.readViewerToken(token)).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
