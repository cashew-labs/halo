import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const parameters = Type.Object({ text: Type.String({ minLength: 1 }) });

/** Delivery is Pi's committed result, not an effect performed by this tool. */
export const sendUserMessageTool: ToolRegistration = {
  name: "send_user_message",
  description:
    "Send a text or Markdown message to the user in this conversation. The user sees none of your work by default: ordinary assistant text, tool activity, and even your final answer are private. Call this tool to deliver answers, questions, updates, and results. Reply to direct user requests before ending your turn; background work with nothing useful to report may finish silently. Sending does not end your work; you may continue and send more messages. Takes no recipient.",
  parameters,
  replay: "safe",
  execute: async (args) => {
    if (!Value.Check(parameters, args) || args.text.trim() === "")
      return {
        isError: true,
        content: [{ type: "text", text: "Provide a nonempty message text." }],
      };
    return {
      content: [{ type: "text", text: "Message sent." }],
      details: { kind: "agent.userMessage", text: args.text },
    };
  },
};
