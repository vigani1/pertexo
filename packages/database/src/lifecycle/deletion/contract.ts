export type WorkspaceLifecycleCommandType =
  'deletion_requested' | 'deletion_restored';

/** The receipt of one deletion or restore request. */
export type WorkspaceLifecycleOperation = Readonly<{
  id: string;
  workspaceId: string;
  commandType: WorkspaceLifecycleCommandType;
  submittedAt: Date;
}>;

export type WorkspaceLifecycleChange = Readonly<{
  operationId: string;
  workspaceId: string;
  actorUserId: string;
  commandType: WorkspaceLifecycleCommandType;
  reason: string;
  idempotencyKeyHash: string;
  requestHash: string;
}>;
