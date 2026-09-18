import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import {
  formatSkillsForSystemPrompt,
  type Skill,
} from "@earendil-works/pi-agent-core";
import * as errore from "errore";
import { haloSystemPrompt, type HaloEnvironment } from "./workspacePrompt.js";

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
    const skills: Skill[] = [];
    for (const skill of loaded.skills) {
      const content = await readInstructions(skill.filePath);
      if (content instanceof Error) return content;
      skills.push({ ...skill, content });
    }
    this.skills = skills;
    this.instructions = "";
    const path = join(this.workspaceRoot, "AGENTS.md");
    if (!existsSync(path)) return;
    const content = await readInstructions(path);
    if (content instanceof Error) return content;
    this.instructions = `<project_context>\n<project_instructions path="${path}">\n${content}\n</project_instructions>\n</project_context>`;
  }

  getResources() {
    return { skills: this.skills };
  }
  getSystemPrompt() {
    return [
      haloSystemPrompt({
        environment: this.environment,
        workspaceRoot: this.workspaceRoot,
      }),
      this.instructions,
      formatSkillsForSystemPrompt(this.skills),
      `Current working directory: ${this.workspaceRoot}`,
    ].join("\n\n");
  }
}

async function readInstructions(path: string) {
  return await readFile(path, "utf8").catch(
    (cause) => new WorkspaceInstructionsError({ path, cause }),
  );
}
