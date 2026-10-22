import { Route, Switch } from "wouter";
import type { ThreadSummary } from "@get-halo/client";
import { AgentPane, DraftAgentPane } from "./agent/AgentPane.tsx";
import { FilePane } from "./FilePane.tsx";
import { ExtensionPane } from "./ExtensionPane.js";
import { AutomationPane } from "./AutomationPane.js";
import { DesktopPane } from "./DesktopPane.js";

export function MainPane({ threads }: { threads: ThreadSummary[] }) {
  return (
    <Switch>
      <Route path="/desktop">
        <DesktopPane />
      </Route>
      <Route path="/extensions/:extensionId">
        {(params) => (
          <ExtensionPane extensionId={decodeURIComponent(params.extensionId)} />
        )}
      </Route>
      <Route path="/automations/:automationId">
        {(params) => (
          <AutomationPane
            automationId={decodeURIComponent(params.automationId)}
          />
        )}
      </Route>
      <Route path="/routines/:routineId">
        {(params) => (
          <AutomationPane automationId={decodeURIComponent(params.routineId)} />
        )}
      </Route>
      <Route path="/files/*">
        {(params) => <FilePane path={decodeURIComponent(params["*"])} />}
      </Route>
      <Route path="/draft/:draftId">
        {(params) => (
          <DraftAgentPane
            key={params.draftId}
            draftId={params.draftId}
            threads={threads}
          />
        )}
      </Route>
      {/* Keep existing conversation URLs valid for saved links and tabs. */}
      <Route path="/sessions/:threadId">
        {(params) => (
          <AgentPane
            key={params.threadId}
            threadId={params.threadId}
            threads={threads}
          />
        )}
      </Route>
    </Switch>
  );
}
