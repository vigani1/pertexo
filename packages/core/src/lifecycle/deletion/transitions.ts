import type { WorkspaceLifecycleCommandType } from './contract.js';

/** How long a workspace waits for restore before it is purged. */
export const WORKSPACE_RECOVERY_DAYS = 30;

type WorkspaceLifecycleState = Readonly<{
  status: string;
  restorable: boolean;
}>;

/** Which workspace each command applies to, and what the audit calls it. */
export const LIFECYCLE_TRANSITIONS: Readonly<
  Record<
    WorkspaceLifecycleCommandType,
    Readonly<{
      auditAction: string;
      appliesTo: (current: WorkspaceLifecycleState) => boolean;
    }>
  >
> = {
  deletion_requested: {
    auditAction: 'workspace.deletion_requested',
    appliesTo: ({ status }) => status === 'active' || status === 'suspended',
  },
  deletion_restored: {
    auditAction: 'workspace.deletion_restored',
    appliesTo: ({ status, restorable }) =>
      status === 'pending_deletion' && restorable,
  },
  reactivated: {
    auditAction: 'workspace.reactivated',
    appliesTo: ({ status }) => status === 'suspended',
  },
};
