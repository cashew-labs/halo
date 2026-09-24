import { createStorageConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import type { PiBackendFixture } from "./fixtures.test.js";
import { piBackendTest } from "./fixtures.test.js";

const conformanceManifest = createStorageConformance(async () => {
  throw new Error("The Pi backend fixture has not been bound");
});
const largeListScenario = "clamps one read page without limiting list growth";

for (const [index, identity] of conformanceManifest.entries()) {
  let fixture: PiBackendFixture | undefined;
  const scenario = createStorageConformance(async () => {
    if (fixture === undefined)
      throw new Error("The Pi backend fixture has not been bound");
    return await fixture.openStorage();
  })[index];
  if (scenario === undefined)
    throw new Error("Missing Pi conformance scenario");

  piBackendTest(
    `${identity.group}: ${identity.name}`,
    async ({ piBackend }) => {
      fixture = piBackend;
      try {
        await scenario.run();
      } finally {
        fixture = undefined;
      }
    },
    identity.name === largeListScenario ? 60_000 : undefined,
  );
}
