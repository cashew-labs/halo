import type { ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const parameters = Type.Object({ text: Type.String({ minLength: 1 }) });

/** Delivery is Pi's committed result, not an effect performed by this tool. */
export const sendUserMessageTool: ToolRegistration = {
  name: "send_user_message",
  description:
    "Send a text or Markdown message to the user in your conversation. This is the only way the user sees your words; ordinary assistant text and tool activity are private. You may send several messages, continue working after sending, or finish silently. Takes no recipient.",
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
