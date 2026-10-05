import {
  haloProtocolVersion,
  haloSupportedProtocols,
} from "../packages/client/src/contract.ts";
import {
  controlPlaneProtocolVersion,
  controlPlaneSupportedProtocols,
} from "../packages/shared/src/controlPlaneContract.ts";

process.stdout.write(
  JSON.stringify({
    workspace: {
      client: haloProtocolVersion,
      supported: haloSupportedProtocols,
    },
    controlPlane: {
      client: controlPlaneProtocolVersion,
      supported: controlPlaneSupportedProtocols,
    },
  }),
);
