import {
  workspaceNoticeKindSchema,
  type WorkspaceNoticeKind,
} from '@pertexo/contracts';
export type InboxSearch = Readonly<{
  filter?: 'unread';
  noticeKind?: WorkspaceNoticeKind;
}>;
export function parseInboxSearch(
  search: Readonly<Record<string, unknown>>,
): InboxSearch {
  const kind = workspaceNoticeKindSchema.safeParse(search.noticeKind);
  return {
    ...(search.filter === 'unread' ? { filter: 'unread' as const } : {}),
    ...(kind.success ? { noticeKind: kind.data } : {}),
  };
}
