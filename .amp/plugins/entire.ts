import type {
  AgentEndEvent,
  AgentStartEvent,
  PluginAPI,
  SessionStartEvent,
  ThreadMessage,
} from "@ampcode/plugin";
import { execFile } from "node:child_process";

// entire-agent-amp: project-local Entire integration for Amp.
export default function (amp: PluginAPI) {
  // In-memory session tracking.
  let currentThreadId: string | null = null;
  const seenThreads = new Set<string>();

  // trackThread records the given thread id and returns true when it is the
  // first time we have seen it for the current session. When a different
  // thread id is discovered we clear all tracking — the user has switched to
  // a new thread, so prior dedupe state no longer applies.
  function trackThread(threadId: string): boolean {
    if (threadId !== currentThreadId) {
      seenThreads.clear();
      currentThreadId = threadId;
    }
    if (seenThreads.has(threadId)) return false;
    seenThreads.add(threadId);
    return true;
  }

  function fireHook(hookName: string, data: Record<string, unknown>): Promise<void> {
    return new Promise((resolve) => {
      let body: string;
      try {
        body = JSON.stringify(data);
      } catch (err) {
        amp.logger.log("entire hook stringify failed", hookName, err);
        resolve();
        return;
      }

      // NOTE: we await this from request handlers (agent.start/agent.end) on
      // purpose — Entire's transcript ordering depends on hooks completing in
      // sequence. Do not convert to fire-and-forget.
      const child = execFile(
        "entire",
        ["hooks", "amp", hookName],
        { timeout: 10_000, windowsHide: true, maxBuffer: Infinity },
        (err, _stdout, stderr) => {
          if (err) {
            amp.logger.log("entire hook failed", hookName, err.message, stderr);
          }
          resolve();
        },
      );
      child.stdin?.end(body);
    });
  }

  function modifiedFiles(messages: ThreadMessage[]): string[] {
    const files = new Set<string>();
    for (const item of amp.helpers.toolCallsInMessages(messages)) {
      for (const event of [item.call, item.result]) {
        const modified = amp.helpers.filesModifiedByToolCall(event);
        if (!modified) continue;
        for (const file of modified) files.add(amp.helpers.filePathFromURI(file));
      }
    }
    return Array.from(files).sort();
  }

  amp.on("session.start", async (event: SessionStartEvent): Promise<void> => {
    const threadId = event.thread?.id;
    if (!threadId) return;
    if (!trackThread(threadId)) return;
    await fireHook("session.start", {
      type: "session.start",
      cwd: process.cwd(),
      thread_id: threadId,
    });
  });

  amp.on("agent.start", async (event: AgentStartEvent): Promise<void> => {
    // Amp's session.start does not always include a thread id, so agent.start
    // is the fallback point for firing the synthetic session.start hook.
    if (trackThread(event.thread.id)) {
      await fireHook("session.start", {
        type: "session.start",
        cwd: process.cwd(),
        thread_id: event.thread.id,
      });
    }

    await fireHook("agent.start", {
      type: "agent.start",
      cwd: process.cwd(),
      thread_id: event.thread.id,
      message_id: String(event.id),
      message: event.message,
    });
  });

  amp.on("agent.end", async (event: AgentEndEvent): Promise<void> => {
    await fireHook("agent.end", {
      type: "agent.end",
      cwd: process.cwd(),
      thread_id: event.thread.id,
      message_id: String(event.id),
      message: event.message,
      status: event.status,
      messages: event.messages,
      modified_files: modifiedFiles(event.messages),
    });
  });
}
