/** The Team page's URL state: the open tab and whether the invite lens is open. */
export type TeamSearch = Readonly<{
  tab?: 'invitations';
  invite?: true;
}>;

export function parseTeamSearch(
  search: Readonly<Record<string, unknown>>,
): TeamSearch {
  return {
    ...(search.tab === 'invitations' ? { tab: 'invitations' } : {}),
    ...(search.invite === true ||
    search.invite === 'true' ||
    search.invite === 1
      ? { invite: true }
      : {}),
  };
}
