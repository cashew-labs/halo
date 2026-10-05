import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const [operation, directory, version, revision] = process.argv.slice(2);
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.match(revision, /^[0-9a-f]{40}$/);
const sha256 = createHash("sha256")
  .update(fs.readFileSync(path.join(directory, "desktop.tgz")))
  .digest("hex");
const identity = { version, revision, sha256 };
const file = path.join(directory, "identity.json");
if (operation === "record")
  fs.writeFileSync(file, `${JSON.stringify(identity)}\n`);
else {
  assert.equal(operation, "verify");
  assert.deepEqual(
    JSON.parse(fs.readFileSync(file, "utf8")),
    identity,
    "Prepared desktop differs from the requested release, source or digest",
  );
}
