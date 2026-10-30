import type { AccessibleWorkspace } from '@pertexo/contracts';
import {
  BROWSABLE_WORKSPACE_STATUSES,
  capabilitiesForRole,
} from '@pertexo/workflow-model';
import type { StatusTone } from '@/components/ui/status';

export type WorkspaceAvailability = Readonly<{
  openable: boolean;
  tone: StatusTone;
  /** The status word next to the glyph. */
  status: string;
  /** A short sentence when the workspace can't simply be opened. */
  note?: string;
  /** The card's call to action when it differs from opening. */
  action?: string;
}>;

/**
 * The one rule for opening a workspace, shared by the picker, landing,
 * switcher and deep links. A suspended (for example restored) workspace can be
 * browsed (ADR 013/027); one being deleted only by someone who can restore it.
 */
export function isWorkspaceOpenable(workspace: AccessibleWorkspace): boolean {
  return (
    workspace.status !== 'pending_deletion' ||
    workspace.capabilities.includes('workspace:manage')
  );
}

type Capability = AccessibleWorkspace['capabilities'][number];

/** Reading, and what lifts or ends the suspension. */
const SUSPENDED_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>([
  'workspace:read',
  'workspace:manage',
  'workflow:read',
  'run:read',
  'artifact:read',
  'audit:read',
  'connection:read',
  'member:read',
  'notification:read',
]);

/**
 * What the person can do here now: a suspended workspace reads but does not
 * change (ADR 013/027), so every capability-gated control follows at once.
 */
export function withCurrentCapabilities(
  workspace: AccessibleWorkspace,
): AccessibleWorkspace {
  if (workspace.status !== 'suspended') return workspace;
  return {
    ...workspace,
    capabilities: workspace.capabilities.filter((capability) =>
      SUSPENDED_CAPABILITIES.has(capability),
    ),
  };
}

/** Whether the workspace's pages read at all. */
export function isWorkspaceBrowsable(
  workspace: Pick<AccessibleWorkspace, 'status'>,
): boolean {
  return BROWSABLE_WORKSPACE_STATUSES.some(
    (status) => status === workspace.status,
  );
}

/** What the person holds, including what a suspension has only paused. */
export function heldCapabilities(
  workspace: Pick<AccessibleWorkspace, 'status' | 'role' | 'capabilities'>,
): readonly Capability[] {
  return workspace.status === 'suspended'
    ? capabilitiesForRole(workspace.role)
    : workspace.capabilities;
}

/**
 * For pages whose reading sits behind a capability that suspension takes away
 * from their controls.
 */
export function holdsCapability(
  workspace: Pick<AccessibleWorkspace, 'status' | 'role' | 'capabilities'>,
  capability: Capability,
): boolean {
  return heldCapabilities(workspace).includes(capability);
}

/** How a workspace card reads and whether it opens, in words. */
export function workspaceAvailability(
  workspace: AccessibleWorkspace,
): WorkspaceAvailability {
  const openable = isWorkspaceOpenable(workspace);
  if (workspace.status === 'suspended')
    return {
      openable,
      tone: 'canceled',
      status: 'Suspended',
      note: 'Runs and changes are paused.',
    };
  if (workspace.status === 'pending_deletion')
    return openable
      ? {
          openable,
          tone: 'attention',
          status: 'Scheduled for deletion',
          note: 'You can still restore it.',
          action: 'Restore',
        }
      : {
          openable,
          tone: 'attention',
          status: 'Being deleted',
          note: 'An owner scheduled this workspace for deletion.',
        };
  return { openable, tone: 'success', status: 'Active' };
}
