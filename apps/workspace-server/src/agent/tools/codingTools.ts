import { workspaceExecutablePath } from "../../workspace/installHaloCli.js";
import { createBashTool } from "@earendil-works/pi-coding-agent";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { type TSchema, Type } from "typebox";
import type { FilesystemService } from "../../filesystem/FilesystemService.js";
import type { AgentAuthority } from "../runtime/AgentAuthority.js";
import { BashTimeoutLimitError, maxBashTimeoutMs } from "./bash/run.js";
import { editFile } from "./files/edit.js";
import { patchFiles } from "./files/patch.js";
import { readFile } from "./files/read.js";
import { writeFile } from "./files/write.js";

const readParameters = Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),
  limit: Type.Optional(Type.Number()),
});

const editParameters = Type.Object({
  path: Type.String(),
  oldText: Type.String(),
  newText: Type.String(),
  replaceAll: Type.Optional(Type.Boolean()),
});

const writeParameters = Type.Object({
  path: Type.String(),
  content: Type.String(),
});

const patchParameters = Type.Object({
  patchText: Type.String({ description: "Patch in apply_patch format." }),
});

type Authorization = {
  pluginId: string;
  toolName: string;
  requiredCapabilities: readonly string[];
};

export function createAuthorizedCodingTools(input: {
  cwd: string;
  filesystem: FilesystemService;
  authority: AgentAuthority;
}) {
  const bash = createBashTool(input.cwd, {
    spawnHook: (context) => ({
      ...context,
      env: {
        ...context.env,
        PATH: workspaceExecutablePath(input.cwd, context.env.PATH),
        PAGER: "cat",
      },
    }),
  });
  return [
    withAuthority(
      createReadTool(input.filesystem, input.cwd),
      input.authority,
      authorization("files", "read", "workspace.files.read"),
    ),
    withAuthority(
      createEditTool(input.filesystem, input.cwd),
      input.authority,
      authorization("files", "edit", "workspace.files.write"),
    ),
    withAuthority(
      createWriteTool(input.filesystem, input.cwd),
      input.authority,
      authorization("files", "write", "workspace.files.write"),
    ),
    withAuthority(
      createPatchTool(input.filesystem, input.cwd),
      input.authority,
      authorization("files", "patch", "workspace.files.write"),
    ),
    withAuthority(
      {
        ...bash,
        description: bash.description.replace(
          "Optionally provide a timeout in seconds.",
          "Timeout defaults to 10 seconds. Maximum 10 minutes.",
        ),
        async execute(id, params, signal, onUpdate) {
          const timeout = params.timeout === undefined ? 10 : params.timeout;
          if (timeout > maxBashTimeoutMs / 1_000) {
            throw new BashTimeoutLimitError({ timeoutMs: timeout * 1_000 });
          }
          return await bash.execute(
            id,
            { ...params, timeout },
            signal,
            onUpdate,
          );
        },
      },
      input.authority,
      authorization("bash", "run", "workspace.shell.execute"),
    ),
  ] as const;
}

function authorization(
  pluginId: string,
  toolName: string,
  capability: string,
): Authorization {
  return { pluginId, toolName, requiredCapabilities: [capability] };
}

function withAuthority<TParameters extends TSchema, TDetails>(
  tool: AgentTool<TParameters, TDetails>,
  authority: AgentAuthority,
  toolAuthorization: Authorization,
): AgentTool<TParameters, TDetails> {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      await authorize(authority, toolAuthorization);
      return await tool.execute(id, params, signal, onUpdate);
    },
  };
}

function createPatchTool(
  filesystem: FilesystemService,
  cwd: string,
): AgentTool<
  typeof patchParameters,
  { added: string[]; modified: string[]; deleted: string[] }
> {
  return {
    name: "patch",
    label: "Patch",
    description: "Apply an apply_patch patch to files in the active workspace.",
    parameters: patchParameters,
    async execute(_id, params) {
      const result = await patchFiles({ filesystem, cwd, input: params });
      if (result instanceof Error) throw result;
      return {
        content: [{ type: "text", text: JSON.stringify(result, undefined, 2) }],
        details: result,
      };
    },
  };
}

function createReadTool(
  filesystem: FilesystemService,
  cwd: string,
): AgentTool<typeof readParameters, { path: string; text: string }> {
  return {
    name: "read",
    label: "Read",
    description: "Read a UTF-8 file in the active workspace.",
    parameters: readParameters,
    async execute(_id, params) {
      const result = await readFile({ filesystem, cwd, input: params });
      if (result instanceof Error) throw result;
      return {
        content: [{ type: "text", text: result.text }],
        details: result,
      };
    },
  };
}

function createEditTool(
  filesystem: FilesystemService,
  cwd: string,
): AgentTool<typeof editParameters, { path: string; replacements: number }> {
  return {
    name: "edit",
    label: "Edit",
    description: "Replace exact text in a workspace file.",
    parameters: editParameters,
    async execute(_id, params) {
      const result = await editFile({ filesystem, cwd, input: params });
      if (result instanceof Error) throw result;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

function createWriteTool(
  filesystem: FilesystemService,
  cwd: string,
): AgentTool<typeof writeParameters, { path: string }> {
  return {
    name: "write",
    label: "Write",
    description: "Write a UTF-8 file in the active workspace.",
    parameters: writeParameters,
    async execute(_id, params) {
      const result = await writeFile({ filesystem, cwd, input: params });
      if (result instanceof Error) throw result;
      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  };
}

async function authorize(
  authority: AgentAuthority,
  toolAuthorization: Authorization,
) {
  const denied = await authority.authorize(toolAuthorization);
  // Pi reports rejected tool promises as failed tool calls.
  if (denied instanceof Error) throw denied;
}
