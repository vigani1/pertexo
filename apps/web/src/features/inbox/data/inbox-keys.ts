import type {
  WorkspaceNoticeKind,
  WorkspaceInboxFilter,
} from '@pertexo/contracts';

// The inbox's cache keys, apart from its reads, so a signed-out page can
// refresh them without loading the inbox's queries.

const PREFERENCES = 'preferences';

export const inboxKeys = {
  scope: (userId: string, workspaceId: string) =>
    ['identity', userId, 'workspace', workspaceId, 'inbox'] as const,
  summary: (userId: string, workspaceId: string) =>
    [...inboxKeys.scope(userId, workspaceId), 'summary'] as const,
  threads: (
    userId: string,
    workspaceId: string,
    filter: WorkspaceInboxFilter,
    noticeKind?: WorkspaceNoticeKind,
  ) =>
    [
      ...inboxKeys.scope(userId, workspaceId),
      'threads',
      filter,
      noticeKind ?? 'all',
    ] as const,
  preferences: (userId: string, workspaceId: string) =>
    [...inboxKeys.scope(userId, workspaceId), PREFERENCES] as const,
};

/** Any person's cached email schedule in any workspace, by its key's shape. */
export function isNotificationPreferencesKey(queryKey: readonly unknown[]) {
  const shape = inboxKeys.preferences('', '');
  return (
    queryKey.length === shape.length &&
    shape.every((part, index) => part === '' || queryKey[index] === part)
  );
}
