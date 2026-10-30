import type { AccessibleWorkspace } from '@pertexo/contracts';
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
