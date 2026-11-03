# Using the prompt lab with Halo

Run these from the Halo repository root.

Render the system prompt with Halo's production loader, `WorkspaceResourceLoader.getSystemPrompt`. It adds the workspace's `AGENTS.md`, its skills, and the environment block to `haloSystemPrompt`, so point it at the workspace whose users you are tuning for. The lab sends no tools, so leave out memory guidance:

```sh
mkdir -p tmp/prompt-lab
workspace="$PWD/tmp/workspace"
(cd packages/workspace-server && node --import tsx --input-type=module -e "const {WorkspaceResourceLoader} = await import('./src/agent/WorkspaceResourceLoader.ts'); const loader = new WorkspaceResourceLoader({environment:'local', workspaceRoot: process.argv[1], threadId:'prompt-lab', memory:false}); const error = await loader.reload(); if (error instanceof Error) throw error; process.stdout.write(loader.getSystemPrompt())" "$workspace") > tmp/prompt-lab/halo-prompt.md
```

Set `workspace` to another absolute path to test against its instructions and skills.

Match Halo's model in `lab.json`. The values come from `togetherModel` in `packages/config/src/inference.ts`; Halo runs it with low reasoning, which Together receives as `reasoning.enabled`:

```json
{
  "baseUrl": "https://api.together.ai/v1",
  "model": "deepseek-ai/DeepSeek-V4.1-Flash",
  "apiKeyEnv": "TOGETHER_API_KEY",
  "request": { "max_tokens": 8192, "reasoning": { "enabled": true } }
}
```

Read the Together key from Secret Manager with Application Default Credentials, in the same command as `run`, so the key never lands in a file:

```sh
TOGETHER_API_KEY=$(cd packages/config && node --input-type=module -e "const {readGcpSecret} = await import('./src/readGcpSecret.ts'); const key = await readGcpSecret({projectId:'halo-relay', secretId:'together-ai-api-key'}); if (key instanceof Error) throw key; process.stdout.write(key)") \
  node .agents/skills/prompt-lab/scripts/prompt-lab.mjs run tmp/prompt-lab/<name>
```

The approved wording goes into `packages/workspace-server/src/agent/workspacePrompt.ts`.
