/** Halo identity only; each provider owns its VM naming and resource lookup. */
export type WorkspaceProviderInput = {
  workspaceId: string;
  ownerUserId: string;
};

/** Server-side connection details. Credentials must not be sent to clients. */
export type WorkspaceProviderConnection = {
  origin: string;
  authorization:
    | {
        type: "bearer";
        /** Complete Authorization header value, including the Bearer prefix. */
        value: string;
      }
    | {
        type: "headers";
        /** Complete provider credentials for private HTTP and WebSocket ingress. */
        value: Readonly<Record<string, string>>;
      }
    | { type: "googleIdentity" };
};

/**
 * Infrastructure operations supplied to the control plane by its host.
 * Workspace ownership, authorization, and idle policy belong to the control plane.
 * Implementations return expected failures as Error values.
 */
export interface WorkspaceProviderApi {
  /**
   * Idempotently provision or reuse the workspace and bring it online.
   * Concurrent calls for the same identity must not create separate workspaces.
   * Success does not guarantee that the workspace server is ready for requests.
   */
  ensure(input: WorkspaceProviderInput): Promise<void | Error>;

  /**
   * Resolve a connection without provisioning or waking the workspace.
   * Return undefined when connection details are not available yet.
   */
  getConnection(
    input: WorkspaceProviderInput,
  ): Promise<WorkspaceProviderConnection | undefined | Error>;

  /**
   * Suspend execution without deleting the workspace; absent when unsupported.
   * Enable automatic idle pause only when both pause and resume are available.
   */
  pause?: (input: WorkspaceProviderInput) => Promise<void | Error>;

  /** Wake a paused workspace; absent when unsupported. Does not imply server readiness. */
  resume?: (input: WorkspaceProviderInput) => Promise<void | Error>;
}
