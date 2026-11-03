# Using the prompt lab with Halo

Run these from the Halo repository root.

Render Halo's system prompt. The lab sends no tools, so leave out memory guidance:

```sh
mkdir -p tmp/prompt-lab
pnpm --silent exec tsx -e "import {haloSystemPrompt} from './packages/workspace-server/src/agent/workspacePrompt.ts'; process.stdout.write(haloSystemPrompt({environment:'local', memory:false}))" > tmp/prompt-lab/halo-prompt.md
```

This is only the part of the prompt that `haloSystemPrompt` writes. Halo also appends the workspace's `AGENTS.md`, its skills, and an environment block; see `WorkspaceResourceLoader.getSystemPrompt`.

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
