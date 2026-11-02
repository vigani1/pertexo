/** Raised when a flow's actor has no authority in the workspace it names. */
export class WorkspaceAccessDeniedError extends Error {
  public override readonly name = 'WorkspaceAccessDeniedError';
}
