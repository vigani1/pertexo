import type { AccessibleWorkspace } from '@pertexo/contracts';

/**
 * The revision "Mark all read" marks up to, or undefined when it can't run:
 * only an active workspace takes the command, only a list that has loaded
 * has a revision, and only unread notices give it work. Marking up to what
 * the list showed keeps later arrivals unread.
 */
export function markAllReadCut({
  workspaceStatus,
  listedRevision,
  unreadCount,
}: Readonly<{
  workspaceStatus: AccessibleWorkspace['status'];
  listedRevision: string | undefined;
  unreadCount: number | undefined;
}>): string | undefined {
  if (workspaceStatus !== 'active') return undefined;
  if ((unreadCount ?? 0) === 0) return undefined;
  return listedRevision;
}
