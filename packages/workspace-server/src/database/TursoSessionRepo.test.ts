import { createSessionRepoConformance } from "@earendil-works/pi-agent-core/harness/session/testing";
import type { PiBackendFixture } from "./fixtures.test.js";
import { piBackendTest } from "./fixtures.test.js";

const conformanceManifest = createSessionRepoConformance(async () => {
  throw new Error("The Pi backend fixture has not been bound");
});

for (const [index, identity] of conformanceManifest.entries()) {
  let fixture: PiBackendFixture | undefined;
  const scenario = createSessionRepoConformance(async () => {
    if (fixture === undefined)
      throw new Error("The Pi backend fixture has not been bound");
    return fixture.repo;
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
  );
}
