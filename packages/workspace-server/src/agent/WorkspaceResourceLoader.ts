import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@earendil-works/pi-coding-agent";
import * as errore from "errore";
import {
  haloEnvironmentPrompt,
  haloSystemPrompt,
  type HaloEnvironment,
} from "./workspacePrompt.js";

class WorkspaceInstructionsError extends errore.createTaggedError({
  name: "WorkspaceInstructionsError",
  message: "Could not read workspace instructions at '$path'",
}) {}

export class WorkspaceResourceLoader {
  // Skills loaded from the workspace for the next agent session.
  private skills: Skill[] = [];
  // Root instructions loaded from the workspace's AGENTS.md.
  private instructions = "";
  private readonly environment: HaloEnvironment;
  private readonly workspaceRoot: string;

  constructor(ctx: { environment: HaloEnvironment; workspaceRoot: string }) {
    this.environment = ctx.environment;
    this.workspaceRoot = ctx.workspaceRoot;
  }

  async reload() {
    const loaded = loadSkillsFromDir({
      dir: join(this.workspaceRoot, ".agents", "skills"),
      source: "workspace",
    });
    this.skills = loaded.skills;
    this.instructions = "";
    const path = join(this.workspaceRoot, "AGENTS.md");
    if (!existsSync(path)) return;
    const content = await readInstructions(path);
    if (content instanceof Error) return content;
    this.instructions = `<project_context>\n<project_instructions path="${path}">\n${content}\n</project_instructions>\n</project_context>`;
  }

  getSystemPrompt() {
    return [
      haloSystemPrompt({ environment: this.environment }),
      this.instructions,
      formatSkillsForPrompt(this.skills),
      haloEnvironmentPrompt({
        environment: this.environment,
        workspaceRoot: this.workspaceRoot,
      }),
    ]
      .filter((section) => section !== "")
      .join("\n\n");
  }
}

async function readInstructions(path: string) {
  return await readFile(path, "utf8").catch(
    (cause) => new WorkspaceInstructionsError({ path, cause }),
  );
}
