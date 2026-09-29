/** The inbox URL: `?filter=unread` narrows to what this person hasn't read. */
export type InboxSearch = Readonly<{ filter?: 'unread' }>;

export function parseInboxSearch(
  search: Readonly<Record<string, unknown>>,
): InboxSearch {
  return search.filter === 'unread' ? { filter: 'unread' } : {};
}
