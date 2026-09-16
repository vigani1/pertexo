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

/** Raised when a tenant read loses its actor authorization before execution. */
export class WorkspaceAccessDeniedError extends Error {
  public override readonly name = 'WorkspaceAccessDeniedError';
}

export type WorkspaceMemberRoleCommandConflictReason =
  | 'actor_inactive'
  | 'target_missing'
  | 'target_inactive'
  | 'self_change'
  | 'owner_change'
  | 'transition_forbidden'
  | 'revision_conflict'
  | 'idempotency_conflict';

export class WorkspaceMemberRoleCommandConflictError extends Error {
  public override readonly name = 'WorkspaceMemberRoleCommandConflictError';

  public constructor(
    public readonly reason: WorkspaceMemberRoleCommandConflictReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
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
