export type IdentityConflictReason = 'identity' | 'workspace_slug';

export class IdentityConflictError extends Error {
  public override readonly name = 'IdentityConflictError';
  public readonly reason: IdentityConflictReason;

  public constructor(
    message: string,
    options: ErrorOptions & Readonly<{ reason?: IdentityConflictReason }> = {},
  ) {
    super(message, options);
    this.reason = options.reason ?? 'identity';
  }
}

export class IdentityNotFoundError extends Error {
  public override readonly name = 'IdentityNotFoundError';
}

export type WorkspaceLifecycleConflictReason =
  'actor_inactive' | 'invalid_state';

export class WorkspaceLifecycleConflictError extends Error {
  public override readonly name = 'WorkspaceLifecycleConflictError';

  public constructor(
    public readonly reason: WorkspaceLifecycleConflictReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}
