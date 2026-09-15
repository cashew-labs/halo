import { Route, Switch } from "wouter";
import type { SessionSummary } from "@get-halo/shared/rpc";
import { AgentPane, DraftAgentPane } from "./agent/AgentPane.tsx";
import { FilePane } from "./FilePane.tsx";
import { ExtensionPane } from "./ExtensionPane.js";

export function MainPane({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <Switch>
      <Route path="/extensions/:extensionId">
        {(params) => (
          <ExtensionPane extensionId={decodeURIComponent(params.extensionId)} />
        )}
      </Route>
      <Route path="/files/*">
        {(params) => <FilePane path={decodeURIComponent(params["*"])} />}
      </Route>
      <Route path="/draft/:draftId">
        {(params) => (
          <DraftAgentPane key={params.draftId} draftId={params.draftId} />
        )}
      </Route>
      <Route path="/sessions/:sessionId">
        {(params) => (
          <AgentPane sessionId={params.sessionId} sessions={sessions} />
        )}
      </Route>
    </Switch>
  );
}
