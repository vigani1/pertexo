export type WorkspaceLifecycleCommandType =
  'deletion_requested' | 'deletion_restored' | 'reactivated';

/** The receipt of one deletion, restore or reactivation request. */
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

export type RequestWorkspaceLifecycleOperationInput = Readonly<{
  workspaceId: string;
  actorUserId: string;
  commandType: WorkspaceLifecycleOperation['commandType'];
  reason: string;
  idempotencyKey: string;
}>;
