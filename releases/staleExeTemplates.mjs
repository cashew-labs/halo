import fs from "node:fs";
import process from "node:process";
import { staleExeTemplates } from "./promotion.mjs";

// Usage: ssh exe.dev ls --json | node releases/staleExeTemplates.mjs <production version>
// Prints one template VM name per line.
const productionVersion = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(productionVersion ?? "")) {
  console.error(
    "Usage: ssh exe.dev ls --json | node releases/staleExeTemplates.mjs <production version>",
  );
  process.exit(1);
}
const { vms } = JSON.parse(fs.readFileSync(0, "utf8"));
for (const vmName of staleExeTemplates(
  vms.map((vm) => vm.vm_name),
  productionVersion,
))
  console.log(vmName);
