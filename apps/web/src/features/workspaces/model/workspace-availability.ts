import type { AccessibleWorkspace } from '@pertexo/contracts/schemas/identity-workspace';
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

const ROLE_NAMES: Record<AccessibleWorkspace['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  builder: 'Builder',
  operator: 'Operator',
  viewer: 'Viewer',
};

export function roleName(role: AccessibleWorkspace['role']): string {
  return ROLE_NAMES[role];
}

/** How a workspace card reads and whether it opens, in words. */
export function workspaceAvailability(
  workspace: AccessibleWorkspace,
): WorkspaceAvailability {
  if (workspace.status === 'suspended')
    return {
      openable: false,
      tone: 'canceled',
      status: 'Suspended',
      note: 'Contact support to restore access.',
    };
  if (workspace.status === 'pending_deletion')
    return workspace.capabilities.includes('workspace:manage')
      ? {
          openable: true,
          tone: 'attention',
          status: 'Scheduled for deletion',
          note: 'You can still restore it.',
          action: 'Restore',
        }
      : {
          openable: false,
          tone: 'attention',
          status: 'Being deleted',
          note: 'An owner scheduled this workspace for deletion.',
        };
  return { openable: true, tone: 'success', status: 'Active' };
}
