import fs from "node:fs";
import process from "node:process";
import {
  pinProductionConfig,
  productionConfigPath,
  validatePromotion,
} from "./promotion.mjs";

// Usage: node releases/validatePromotion.mjs <production.json> [<previous production.json>]
// Prints the promoted version.
const [productionPath, previousPath] = process.argv.slice(2);
if (productionPath === undefined)
  fail(
    "Usage: node releases/validatePromotion.mjs <production.json> [<previous production.json>]",
  );

const { version } = readJson(productionPath);
if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
  fail(`Production version must use major.minor.patch: ${version}`);
if (!fs.existsSync(`releases/${version}.json`))
  fail(`releases/${version}.json does not exist`);
const release = readJson(`releases/${version}.json`);
const production =
  previousPath === undefined || !fs.existsSync(previousPath)
    ? undefined
    : readJson(previousPath);

const invalid = validatePromotion({ release, production });
if (invalid instanceof Error) fail(invalid.message);

const config = fs.readFileSync(productionConfigPath, "utf8");
const pinned = pinProductionConfig(config, version);
if (pinned instanceof Error) fail(pinned.message);
if (pinned !== config)
  fail(`${productionConfigPath} must pin the ${version} images and template`);

console.log(version);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
