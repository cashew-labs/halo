import { Route, Switch } from "wouter";
import type { SessionSummary } from "@get-halo/client";
import { AgentPane, DraftAgentPane } from "./agent/AgentPane.tsx";
import { FilePane } from "./FilePane.tsx";
import { ExtensionPane } from "./ExtensionPane.js";
import { AutomationPane, AutomationsPane } from "./AutomationPane.js";
import { DesktopPane } from "./DesktopPane.js";

export function MainPane({ sessions }: { sessions: SessionSummary[] }) {
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
      <Route path="/automations">
        <AutomationsPane />
      </Route>
      <Route path="/automations/:automationId">
        {(params) => (
          <AutomationPane
            automationId={decodeURIComponent(params.automationId)}
            sessions={sessions}
          />
        )}
      </Route>
      <Route path="/routines/:routineId">
        {(params) => (
          <AutomationPane
            automationId={decodeURIComponent(params.routineId)}
            sessions={sessions}
          />
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
            sessions={sessions}
          />
        )}
      </Route>
      <Route path="/sessions/:sessionId">
        {(params) => (
          <AgentPane
            key={params.sessionId}
            sessionId={params.sessionId}
            sessions={sessions}
          />
        )}
      </Route>
    </Switch>
  );
}
