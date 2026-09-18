import * as errore from "errore";
import { GoogleAuth } from "google-auth-library";

const computeApiOrigin = "https://compute.googleapis.com/compute/v1";
const ownerUserIdMetadataKey = "halo-owner-user-id";
const workspaceDiskDeviceName = "halo-workspace";
const workspaceDiskSizeGb = "50";
const auth = new GoogleAuth({
  scopes: ["https://www.googleapis.com/auth/cloud-platform"],
});

class GcpWorkspaceProvisioningError extends errore.createTaggedError({
  name: "GcpWorkspaceProvisioningError",
  message: "Could not provision workspace $workspaceId: $detail",
}) {}

type ComputeTemplateDisk = {
  boot?: boolean;
  initializeParams?: {
    diskSizeGb?: string;
    diskType?: string;
    sourceImage?: string;
  };
};

type ComputeInstanceTemplate = {
  properties?: {
    disks?: ComputeTemplateDisk[];
    metadata?: {
      items?: Array<{ key: string; value?: string }>;
    };
  };
};

type ComputeBootDisk = {
  autoDelete: true;
  boot: true;
  initializeParams: {
    diskSizeGb: string;
    diskType: string;
    sourceImage: string;
  };
  mode: "READ_WRITE";
  type: "PERSISTENT";
};

type WorkspaceInstanceTemplate = {
  bootDisk: ComputeBootDisk;
  metadataItems: Array<{ key: string; value?: string }>;
};

type ComputeInstance = {
  status?: string;
};

type ComputeOperation = {
  error?: {
    errors?: Array<{ code?: string; message?: string }>;
  };
  name?: string;
  status?: string;
};

type GcpWorkspaceConfig = {
  deployment: "gcp";
  instanceTemplate: string;
  projectId: string;
  zone: string;
};

type GcpWorkspaceContext = GcpWorkspaceConfig & {
  workspaceId: string;
};

export async function provisionGcpWorkspace(input: {
  config: GcpWorkspaceConfig;
  ownerUserId: string;
  workspaceId: string;
}) {
  const workspace = { ...input.config, workspaceId: input.workspaceId };
  const diskName = `halo-${input.workspaceId}-workspace`;
  const instanceName = `halo-${input.workspaceId}`;

  const diskOperation = await insertDisk({ ...workspace, diskName });
  if (diskOperation instanceof Error) return diskOperation;

  if (diskOperation !== undefined) {
    const diskReady = await waitForOperation({
      ...workspace,
      operationName: diskOperation,
    });
    if (diskReady instanceof Error) return diskReady;
  }

  const template = await loadInstanceTemplate(workspace);
  if (template instanceof Error) return template;

  const instanceOperation = await insertInstance({
    ...workspace,
    diskName,
    instanceName,
    ownerUserId: input.ownerUserId,
    template,
  });
  if (instanceOperation instanceof Error) return instanceOperation;

  if (instanceOperation !== undefined) {
    const instanceReady = await waitForOperation({
      ...workspace,
      operationName: instanceOperation,
    });
    if (instanceReady instanceof Error) return instanceReady;
  }

  return await ensureInstanceRunning({ ...workspace, instanceName });
}

async function insertDisk(ctx: GcpWorkspaceContext & { diskName: string }) {
  const response = await send({
    workspaceId: ctx.workspaceId,
    detail: "create workspace disk",
    method: "POST",
    url: zoneUrl({ ...ctx, path: "disks" }),
    body: {
      name: ctx.diskName,
      sizeGb: workspaceDiskSizeGb,
      type: `zones/${ctx.zone}/diskTypes/pd-balanced`,
      labels: { "halo-workspace-id": ctx.workspaceId },
    },
  });
  if (response instanceof Error) return response;
  if (response.status === 409) return undefined;

  return await readOperation({
    workspaceId: ctx.workspaceId,
    detail: "create workspace disk",
    response,
  });
}

async function loadInstanceTemplate(ctx: GcpWorkspaceContext) {
  const response = await send({
    workspaceId: ctx.workspaceId,
    detail: "load workspace instance template",
    method: "GET",
    url: globalUrl({
      projectId: ctx.projectId,
      path: `instanceTemplates/${encodeURIComponent(ctx.instanceTemplate)}`,
    }),
  });
  if (response instanceof Error) return response;

  const template = await readJson<ComputeInstanceTemplate>({
    workspaceId: ctx.workspaceId,
    detail: "load workspace instance template",
    response,
  });
  if (template instanceof Error) return template;

  const bootDisk = template.properties?.disks?.find(
    (disk) => disk.boot === true,
  );
  if (bootDisk === undefined)
    return new GcpWorkspaceProvisioningError({
      workspaceId: ctx.workspaceId,
      detail: "workspace instance template has no boot disk",
    });

  const initializeParams = bootDisk.initializeParams;
  if (
    initializeParams?.diskSizeGb === undefined ||
    initializeParams.diskType === undefined ||
    initializeParams.sourceImage === undefined
  )
    return new GcpWorkspaceProvisioningError({
      workspaceId: ctx.workspaceId,
      detail: "workspace instance template has an incomplete boot disk",
    });

  const metadataItems = template.properties?.metadata?.items;
  if (metadataItems === undefined)
    return new GcpWorkspaceProvisioningError({
      workspaceId: ctx.workspaceId,
      detail: "workspace instance template has no metadata",
    });

  return {
    bootDisk: {
      autoDelete: true,
      boot: true,
      initializeParams: {
        diskSizeGb: initializeParams.diskSizeGb,
        diskType: `zones/${ctx.zone}/diskTypes/${initializeParams.diskType}`,
        sourceImage: initializeParams.sourceImage,
      },
      mode: "READ_WRITE",
      type: "PERSISTENT",
    },
    metadataItems,
  } satisfies WorkspaceInstanceTemplate;
}

async function insertInstance(
  ctx: GcpWorkspaceContext & {
    diskName: string;
    instanceName: string;
    ownerUserId: string;
    template: WorkspaceInstanceTemplate;
  },
) {
  const url = zoneUrl({ ...ctx, path: "instances" });
  url.searchParams.set(
    "sourceInstanceTemplate",
    `projects/${ctx.projectId}/global/instanceTemplates/${ctx.instanceTemplate}`,
  );

  const response = await send({
    workspaceId: ctx.workspaceId,
    detail: "create workspace VM",
    method: "POST",
    url,
    body: {
      name: ctx.instanceName,
      labels: { "halo-workspace-id": ctx.workspaceId },
      metadata: {
        items: [
          ...ctx.template.metadataItems.filter(
            (item) => item.key !== ownerUserIdMetadataKey,
          ),
          { key: ownerUserIdMetadataKey, value: ctx.ownerUserId },
          { key: "halo-workspace-id", value: ctx.workspaceId },
        ],
      },
      disks: [
        ctx.template.bootDisk,
        {
          autoDelete: false,
          boot: false,
          deviceName: workspaceDiskDeviceName,
          mode: "READ_WRITE",
          source: `projects/${ctx.projectId}/zones/${ctx.zone}/disks/${ctx.diskName}`,
          type: "PERSISTENT",
        },
      ],
    },
  });
  if (response instanceof Error) return response;
  if (response.status === 409) return undefined;

  return await readOperation({
    workspaceId: ctx.workspaceId,
    detail: "create workspace VM",
    response,
  });
}

async function ensureInstanceRunning(
  ctx: GcpWorkspaceContext & { instanceName: string },
) {
  const response = await send({
    workspaceId: ctx.workspaceId,
    detail: "load workspace VM",
    method: "GET",
    url: zoneUrl({
      ...ctx,
      path: `instances/${encodeURIComponent(ctx.instanceName)}`,
    }),
  });
  if (response instanceof Error) return response;

  const instance = await readJson<ComputeInstance>({
    workspaceId: ctx.workspaceId,
    detail: "load workspace VM",
    response,
  });
  if (instance instanceof Error) return instance;

  if (instance.status === "TERMINATED")
    return await changeInstanceState({ ...ctx, action: "start" });

  if (instance.status === "SUSPENDED")
    return await changeInstanceState({ ...ctx, action: "resume" });

  if (instance.status === undefined)
    return new GcpWorkspaceProvisioningError({
      workspaceId: ctx.workspaceId,
      detail: "workspace VM has no status",
    });

  return undefined;
}

async function changeInstanceState(
  ctx: GcpWorkspaceContext & {
    action: "resume" | "start";
    instanceName: string;
  },
) {
  const response = await send({
    workspaceId: ctx.workspaceId,
    detail: `${ctx.action} workspace VM`,
    method: "POST",
    url: zoneUrl({
      ...ctx,
      path: `instances/${encodeURIComponent(ctx.instanceName)}/${ctx.action}`,
    }),
  });
  if (response instanceof Error) return response;

  const operation = await readOperation({
    workspaceId: ctx.workspaceId,
    detail: `${ctx.action} workspace VM`,
    response,
  });
  if (operation instanceof Error) return operation;

  return await waitForOperation({ ...ctx, operationName: operation });
}

async function waitForOperation(
  ctx: GcpWorkspaceContext & { operationName: string },
): Promise<Error | undefined> {
  const response = await send({
    workspaceId: ctx.workspaceId,
    detail: "wait for Compute Engine operation",
    method: "POST",
    url: zoneUrl({
      ...ctx,
      path: `operations/${encodeURIComponent(ctx.operationName)}/wait`,
    }),
  });
  if (response instanceof Error) return response;

  const operation = await readJson<ComputeOperation>({
    workspaceId: ctx.workspaceId,
    detail: "wait for Compute Engine operation",
    response,
  });
  if (operation instanceof Error) return operation;

  if (operation.status !== "DONE") return await waitForOperation(ctx);

  const operationError = operation.error?.errors?.[0];
  if (operationError !== undefined)
    return new GcpWorkspaceProvisioningError({
      workspaceId: ctx.workspaceId,
      detail: operationErrorDetail(operationError),
    });

  return undefined;
}

async function readOperation(ctx: {
  detail: string;
  response: Response;
  workspaceId: string;
}) {
  const operation = await readJson<ComputeOperation>(ctx);
  if (operation instanceof Error) return operation;

  if (operation.name === undefined)
    return new GcpWorkspaceProvisioningError({
      workspaceId: ctx.workspaceId,
      detail: `${ctx.detail}: response has no operation name`,
    });

  return operation.name;
}

async function readJson<T>(ctx: {
  detail: string;
  response: Response;
  workspaceId: string;
}) {
  if (!ctx.response.ok) return await readHttpFailure(ctx);

  // SAFETY: Each caller supplies the Compute Engine response shape for its endpoint.
  return await (ctx.response.json() as Promise<T>).catch(
    (cause) =>
      new GcpWorkspaceProvisioningError({
        workspaceId: ctx.workspaceId,
        detail: `${ctx.detail}: decode response`,
        cause,
      }),
  );
}

async function readHttpFailure(ctx: {
  detail: string;
  response: Response;
  workspaceId: string;
}) {
  const body = await ctx.response.text().catch(
    (cause) =>
      new GcpWorkspaceProvisioningError({
        workspaceId: ctx.workspaceId,
        detail: `${ctx.detail}: read HTTP ${ctx.response.status} failure`,
        cause,
      }),
  );
  if (body instanceof Error) return body;

  return new GcpWorkspaceProvisioningError({
    workspaceId: ctx.workspaceId,
    detail: `${ctx.detail}: HTTP ${ctx.response.status}: ${body}`,
  });
}

async function send(ctx: {
  body?: object;
  detail: string;
  method: "GET" | "POST";
  url: URL;
  workspaceId: string;
}) {
  const headers = await auth.getRequestHeaders(ctx.url.toString()).catch(
    (cause) =>
      new GcpWorkspaceProvisioningError({
        workspaceId: ctx.workspaceId,
        detail: `${ctx.detail}: authenticate request`,
        cause,
      }),
  );
  if (headers instanceof Error) return headers;

  const requestHeaders = new Headers(headers);
  if (ctx.body !== undefined)
    requestHeaders.set("content-type", "application/json");

  return await fetch(ctx.url, {
    method: ctx.method,
    headers: requestHeaders,
    body: ctx.body === undefined ? undefined : JSON.stringify(ctx.body),
  }).catch(
    (cause) =>
      new GcpWorkspaceProvisioningError({
        workspaceId: ctx.workspaceId,
        detail: ctx.detail,
        cause,
      }),
  );
}

function globalUrl(ctx: { path: string; projectId: string }) {
  return new URL(
    `${computeApiOrigin}/projects/${encodeURIComponent(ctx.projectId)}/global/${ctx.path}`,
  );
}

function zoneUrl(ctx: { path: string; projectId: string; zone: string }) {
  return new URL(
    `${computeApiOrigin}/projects/${encodeURIComponent(ctx.projectId)}/zones/${encodeURIComponent(ctx.zone)}/${ctx.path}`,
  );
}

function operationErrorDetail(error: { code?: string; message?: string }) {
  if (error.message !== undefined) return error.message;
  if (error.code !== undefined) return error.code;
  return "Compute Engine operation failed";
}
