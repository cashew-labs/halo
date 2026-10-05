import assert from "node:assert/strict";
import fs from "node:fs";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";

const [origin, manifestPath, revision] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const client = createORPCClient(new RPCLink({ origin, url: "/rpc" }));
const info = await client.server.info(undefined, {
  signal: AbortSignal.timeout(10_000),
});
assert.equal(
  info.build?.version,
  release.version,
  "Control-plane release differs",
);
assert.equal(info.build?.revision, revision, "Control-plane source differs");
assert.deepEqual(
  info.supportedProtocols,
  release.protocols.controlPlane.supported,
);
console.log("Control-plane protocol and build verified");
