import * as Alchemy from "alchemy";
import * as Cloudflare from "alchemy/Cloudflare";
import * as Effect from "effect/Effect";

import { releases } from "./src/releases.ts";
import { secretsStore } from "./src/secretsStore.ts";

export default Alchemy.Stack(
  "Halo",
  {
    providers: Cloudflare.providers(),
    state: Cloudflare.state(),
  },
  Effect.gen(function* () {
    const resolvedSecretsStore = yield* secretsStore;
    const resolvedReleases = yield* releases;

    return {
      secretsStoreId: resolvedSecretsStore.storeId,
      secretsStoreName: resolvedSecretsStore.storeName,
      releasesBucket: resolvedReleases.bucketName,
    };
  }),
);
