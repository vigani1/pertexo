import {
  workspaceNoticeKindSchema,
  type WorkspaceNoticeKind,
} from '@pertexo/contracts';
export type InboxSearch = Readonly<{
  filter?: 'all' | 'unread';
  noticeKind?: WorkspaceNoticeKind;
}>;
export function parseInboxSearch(
  search: Readonly<Record<string, unknown>>,
): InboxSearch {
  const kind = workspaceNoticeKindSchema.safeParse(search.noticeKind);
  return {
    ...(search.filter === 'unread' || search.filter === 'all'
      ? { filter: search.filter }
      : {}),
    ...(kind.success ? { noticeKind: kind.data } : {}),
  };
}
