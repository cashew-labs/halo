import * as errore from "errore";

export class AgentCapabilityDeniedError extends errore.createTaggedError({
  name: "AgentCapabilityDeniedError",
  message: 'Agent capability "$capability" is not granted',
}) {}

export interface AgentAuthority {
  authorize(input: {
    pluginId: string;
    toolName: string;
    requiredCapabilities: readonly string[];
  }): Promise<void | AgentCapabilityDeniedError>;
}

export class StaticAgentAuthority implements AgentAuthority {
  private readonly capabilities: ReadonlySet<string>;

  constructor(capabilities: readonly string[]) {
    this.capabilities = new Set(capabilities);
  }

  async authorize(input: {
    pluginId: string;
    toolName: string;
    requiredCapabilities: readonly string[];
  }) {
    const denied = input.requiredCapabilities.find(
      (capability) => !this.capabilities.has(capability),
    );
    if (denied === undefined) return;
    return new AgentCapabilityDeniedError({ capability: denied });
  }
}
