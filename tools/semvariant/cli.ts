import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runSemvariant } from "./semvariant.ts";

// Native Node type stripping resolves explicit .ts imports for this local tool.
const root = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
const result = runSemvariant(root, process.argv.slice(2));
if (result instanceof Error) {
  console.error(result.message);
  process.exitCode = 1;
} else {
  console.log(result);
}
