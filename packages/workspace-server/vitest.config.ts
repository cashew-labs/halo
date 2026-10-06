import { defineConfig } from "vitest/config";
import { testTierOptions } from "../../tools/vitest/testTierOptions.ts";

export default defineConfig({ test: testTierOptions("**/fixtures.test.ts") });
